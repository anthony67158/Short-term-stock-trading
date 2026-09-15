"""Short transactions, database row locking and fenced completion."""
import hashlib
import json
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.operations.models import Job, Outbox


class JobConflict(ValueError):
    pass


def submit(owner: str, kind: str, key: str, payload: dict) -> Job:
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    with sessions().begin() as db:
        db.execute(insert(Job).values(
            id=new_id(), owner_id=owner, kind=kind, business_key=key,
            input_hash=digest, payload=payload,
        ).on_conflict_do_nothing(index_elements=["owner_id", "kind", "business_key"]))
        job = db.scalar(select(Job).where(
            Job.owner_id == owner, Job.kind == kind, Job.business_key == key,
        ))
        if job.input_hash != digest:
            raise JobConflict("同一请求标识对应了不同内容")
        return job


def claim(kinds: list[str], lease_seconds: int = 120) -> Job | None:
    now = utcnow()
    with sessions().begin() as db:
        expired = db.scalars(select(Job).where(
            Job.kind.in_(kinds), Job.status == "RUNNING", Job.lease_until <= now,
        ).with_for_update(skip_locked=True)).all()
        for job in expired:
            job.fencing_token += 1
            if job.cancellation_requested:
                job.status = "CANCELLED"
            elif job.external_started or job.attempt >= 3:
                job.status = "FAILED"
                job.error_code = "WORKER_LOST_EXTERNAL_RESULT_UNCERTAIN"
            else:
                job.status = "QUEUED"
                job.stage = "重新等待处理"
        db.flush()
        job = db.scalar(select(Job).where(
            Job.kind.in_(kinds), Job.status == "QUEUED",
            Job.cancellation_requested.is_(False),
        ).order_by(Job.priority.desc(), Job.created_at).limit(1)
            .with_for_update(skip_locked=True))
        if job is None:
            return None
        job.status = "RUNNING"
        job.stage = "准备输入"
        job.attempt += 1
        job.fencing_token += 1
        job.lease_until = now + timedelta(seconds=lease_seconds)
        job.updated_at = now
        return job


def mark_external(job: Job) -> bool:
    with sessions().begin() as db:
        result = db.execute(update(Job).where(
            Job.id == job.id, Job.fencing_token == job.fencing_token,
            Job.status == "RUNNING", Job.cancellation_requested.is_(False),
            Job.lease_until > utcnow(),
        ).values(external_started=True, stage="生成结构化研判", updated_at=utcnow()))
        return result.rowcount == 1


def finish(job: Job, result: dict | None = None, error: str | None = None) -> bool:
    with sessions().begin() as db:
        current = db.scalar(select(Job).where(Job.id == job.id).with_for_update())
        if (current.status != "RUNNING" or current.fencing_token != job.fencing_token
                or current.lease_until <= utcnow()):
            return False
        if current.cancellation_requested:
            current.status = "CANCELLED"
            current.stage = "已取消"
        else:
            current.status = "FAILED" if error else "SUCCEEDED"
            current.stage = "处理失败" if error else "处理完成"
            current.result = result
            current.error_code = error
        current.updated_at = utcnow()
        db.add(Outbox(
            owner_id=current.owner_id, event_type="job.finished",
            aggregate_id=current.id, payload={"status": current.status},
        ))
        return True


def cancel(owner: str, job_id: str) -> Job | None:
    with sessions().begin() as db:
        job = db.scalar(select(Job).where(
            Job.id == job_id, Job.owner_id == owner,
        ).with_for_update())
        if job and job.status in ("QUEUED", "RUNNING"):
            job.cancellation_requested = True
            if job.status == "QUEUED":
                job.status = "CANCELLED"
                job.stage = "已取消"
            job.updated_at = utcnow()
        return job
