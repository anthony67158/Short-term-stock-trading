import hashlib
import json
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from platform_app.adapters.database import sessions
from platform_app.config import settings
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.identity.models import User
from platform_app.modules.market.service import instrument
from platform_app.modules.operations.models import Job
from platform_app.modules.research.contracts import (
    ASSESSMENT_PROTOCOL_VERSION,
    AssessmentPage, AssessmentView, EvidenceInput, EvidencePage, EvidenceView,
    ResearchCapability, ResearchInput,
)
from platform_app.modules.research.models import Assessment, Evidence

PROTOCOL = ASSESSMENT_PROTOCOL_VERSION


def fingerprint(body) -> str:
    return hashlib.sha256(body.model_dump_json().encode()).hexdigest()


class ResearchError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422):
        self.code, self.message, self.status = code, message, status


def capability() -> ResearchCapability:
    config = settings()
    enabled = config.agent_enabled and bool(config.agent_api_key.get_secret_value())
    search_available = config.search_enabled and bool(
        config.search_api_key.get_secret_value()
    )
    return ResearchCapability(
        available=enabled, model=config.agent_model,
        reason=None if enabled else "研究推理服务尚未启用；请先完成供应商鉴权验证",
        timeout_seconds=config.agent_timeout_seconds,
        search_available=search_available,
        search_max_calls=config.agent_search_max_calls if search_available else 0,
        tools=["DOUBAO_SEARCH"] if search_available else [],
    )


def save_evidence(owner: str, body: EvidenceInput, key: str) -> EvidenceView:
    instrument(body.instrument_id)
    now = utcnow()
    if body.published_at > now:
        raise ResearchError("FUTURE_EVIDENCE", "材料发布时间不能晚于当前时间")
    if body.quote not in body.text:
        raise ResearchError("QUOTE_NOT_FOUND", "引用片段必须能在原文中逐字定位")
    digest = fingerprint(body)
    with sessions().begin() as db:
        db.execute(insert(Evidence).values(
            id=new_id(), owner_id=owner, source_key=key, request_hash=digest,
            **body.model_dump(mode="json", exclude={"published_at"}),
            published_at=body.published_at, first_seen_at=now, available_at=now,
            content_hash=hashlib.sha256(body.text.encode()).hexdigest(),
        ).on_conflict_do_nothing(index_elements=["owner_id", "source_key"]))
        row = db.scalar(select(Evidence).where(
            Evidence.owner_id == owner, Evidence.source_key == key,
        ))
        if row.request_hash != digest:
            raise ResearchError("IDEMPOTENCY_CONFLICT", "同一请求编号的内容发生变化", 409)
        return EvidenceView.model_validate(row)


def evidence_list(owner: str, instrument_id: str, cursor: str | None, limit: int) -> EvidencePage:
    with sessions()() as db:
        query = select(Evidence).where(
            Evidence.owner_id == owner, Evidence.instrument_id == instrument_id,
        )
        if cursor:
            query = query.where(Evidence.id > cursor)
        rows = list(db.scalars(query.order_by(Evidence.id).limit(limit + 1)))
        return EvidencePage(
            evidence=[EvidenceView.model_validate(row) for row in rows[:limit]],
            next_cursor=rows[limit - 1].id if len(rows) > limit else None,
        )


def evidence_by_id(owner: str, evidence_id: str) -> EvidenceView:
    with sessions()() as db:
        row = db.scalar(select(Evidence).where(Evidence.id == evidence_id, Evidence.owner_id == owner))
        if not row:
            raise ResearchError("EVIDENCE_NOT_FOUND", "材料不存在或无权访问", 404)
        return EvidenceView.model_validate(row)


def submit_research(owner: str, body: ResearchInput, key: str) -> Job:
    config, now = settings(), utcnow()
    digest = fingerprint(body)
    instrument(body.instrument_id)
    with sessions().begin() as db:
        # One user budget and frozen input transaction; model I/O happens in a worker.
        db.execute(select(func.pg_advisory_xact_lock(618051018)))
        db.scalar(select(User).where(User.id == owner).with_for_update())
        existing = db.scalar(select(Job).where(
            Job.owner_id == owner, Job.kind == "RESEARCH", Job.business_key == key,
        ))
        if existing:
            if existing.input_hash != digest:
                raise ResearchError("IDEMPOTENCY_CONFLICT", "同一请求编号的内容发生变化", 409)
            return existing
        current_capability = capability()
        if not current_capability.available:
            raise ResearchError("AGENT_UNAVAILABLE", current_capability.reason, 503)
        if not body.evidence_ids and not current_capability.search_available:
            raise ResearchError(
                "EVIDENCE_REQUIRED",
                "没有手工材料且搜索服务不可用，无法开始有依据的研究",
            )
        count = db.scalar(select(func.count()).select_from(Job).where(
            Job.owner_id == owner, Job.kind == "RESEARCH",
            Job.created_at >= now - timedelta(hours=24),
        ))
        if count >= config.agent_daily_call_limit:
            raise ResearchError("RESEARCH_BUDGET_EXCEEDED", "已达到24小时研究调用上限", 429)
        total = db.scalar(select(func.count()).select_from(Job).where(
            Job.kind == "RESEARCH", Job.created_at >= now - timedelta(hours=24),
        ))
        if total >= config.agent_global_daily_call_limit:
            raise ResearchError("RESEARCH_BUDGET_EXCEEDED", "平台研究调用预算已用尽", 429)
        rows = list(db.scalars(select(Evidence).where(
            Evidence.owner_id == owner, Evidence.instrument_id == body.instrument_id,
            Evidence.id.in_(body.evidence_ids), Evidence.available_at <= now,
        )))
        if len(rows) != len(set(body.evidence_ids)):
            raise ResearchError("EVIDENCE_SCOPE_INVALID", "材料缺失、无权访问或不属于当前股票")
        evidence = [EvidenceView.model_validate(row).model_dump(mode="json") for row in rows]
        if len(json.dumps(evidence, ensure_ascii=False)) > 60000:
            raise ResearchError("EVIDENCE_BUDGET_EXCEEDED", "材料包过大，请缩小本次研究范围")
        job = Job(
            owner_id=owner, kind="RESEARCH", business_key=key, input_hash=digest,
            payload={"request": body.model_dump(mode="json"), "evidence": evidence,
                     "protocolVersion": PROTOCOL, "model": config.agent_model,
                     "asOf": now.isoformat(), "deadline": (now + timedelta(minutes=3)).isoformat()},
        )
        db.add(job)
        db.flush()
        return job


def assessments(owner: str, instrument_id: str, cursor: str | None, limit: int) -> AssessmentPage:
    with sessions()() as db:
        query = select(Assessment).where(
            Assessment.owner_id == owner, Assessment.instrument_id == instrument_id,
        )
        if cursor:
            query = query.where(Assessment.id > cursor)
        rows = list(db.scalars(query.order_by(Assessment.id).limit(limit + 1)))
        return AssessmentPage(
            assessments=[AssessmentView.model_validate(row) for row in rows[:limit]],
            next_cursor=rows[limit - 1].id if len(rows) > limit else None,
        )
