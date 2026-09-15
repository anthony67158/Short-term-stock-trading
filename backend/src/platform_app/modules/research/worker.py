import hashlib
import json
import time
from datetime import datetime

from platform_app.contracts.base import utcnow
from platform_app.modules.operations import jobs
from platform_app.modules.operations.models import Outbox
from platform_app.modules.research.agent import AgentFailure, run_agent
from platform_app.modules.research.models import Assessment


def process_one() -> bool:
    job = jobs.claim(["RESEARCH"])
    if not job:
        return False
    if datetime.fromisoformat(job.payload["deadline"]) <= utcnow():
        jobs.finish(job, error="DEADLINE_EXCEEDED")
        return True
    if not jobs.mark_external(job):
        jobs.finish(job)
        return True
    try:
        output = run_agent(job.payload)
    except AgentFailure as exc:
        jobs.finish(job, error=str(exc))
        return True

    def publish(db, current):
        record = Assessment(
            owner_id=current.owner_id, instrument_id=current.payload["request"]["instrument_id"],
            job_id=current.id, protocol_version=current.payload["protocolVersion"],
            model_id=current.payload["model"], as_of=datetime.fromisoformat(current.payload["asOf"]),
            input_hash=hashlib.sha256(json.dumps(
                current.payload, sort_keys=True, ensure_ascii=False,
            ).encode()).hexdigest(),
            evidence_ids=[item["id"] for item in current.payload["evidence"]],
            output=output.model_dump(mode="json"),
        )
        db.add(record)
        db.flush()
        db.add(Outbox(
            owner_id=current.owner_id, event_type="research.assessment.updated",
            aggregate_id=record.id,
            payload={"instrumentId": record.instrument_id, "assessmentId": record.id},
        ))
        return {"assessmentId": record.id}

    jobs.finish(job, publish=publish)
    return True


def main():
    while True:
        try:
            processed = process_one()
        except Exception:
            # Never log model output, user evidence or credentials. Lease handles uncertain work.
            print("研究Worker暂时失败，等待任务租约恢复", flush=True)
            processed = False
        if not processed:
            time.sleep(1)


if __name__ == "__main__":
    main()
