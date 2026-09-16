import hashlib
import json
import time
from datetime import date, datetime

from sqlalchemy import select

from platform_app.contracts.base import utcnow
from platform_app.modules.operations import jobs
from platform_app.modules.operations.models import Outbox
from platform_app.modules.review.agent import (
    ReviewAgentFailure,
    run_review_agent,
)
from platform_app.modules.review.contracts import ReviewMetricSnapshot
from platform_app.modules.review.models import (
    ImprovementProposal,
    ReviewReport,
)
from platform_app.modules.review.strategy_agent import (
    StrategyAgentFailure,
    run_strategy_agent,
)
from platform_app.modules.review.strategy_compiler import (
    StrategyCompilationError,
    compile_strategy_proposal,
)


def process_one() -> bool:
    job = jobs.claim(
        ["DAILY_REVIEW", "STRATEGY_PROPOSAL"],
        lease_seconds=330,
    )
    if not job:
        return False
    if datetime.fromisoformat(job.payload["deadline"]) <= utcnow():
        jobs.finish(job, error="DEADLINE_EXCEEDED")
        return True
    if not jobs.mark_external(job):
        jobs.finish(job)
        return True
    if job.kind == "STRATEGY_PROPOSAL":
        try:
            output = run_strategy_agent(job.payload)
        except StrategyAgentFailure as exc:
            jobs.finish(job, error=str(exc))
            return True

        def publish_strategy(db, current):
            return compile_strategy_proposal(db, current, output)

        try:
            jobs.finish(job, publish=publish_strategy)
        except StrategyCompilationError as exc:
            jobs.finish(job, error=str(exc))
        return True
    try:
        output = run_review_agent(job.payload)
    except ReviewAgentFailure as exc:
        jobs.finish(job, error=str(exc))
        return True

    def publish(db, current):
        existing = db.scalar(
            select(ReviewReport).where(
                ReviewReport.job_id == current.id,
            )
        )
        if existing:
            return {"reviewReportId": existing.id}
        snapshot = ReviewMetricSnapshot.model_validate(
            current.payload["metricSnapshot"]
        )
        report = ReviewReport(
            owner_id=current.owner_id,
            job_id=current.id,
            review_date=date.fromisoformat(
                current.payload["request"]["review_date"]
            ),
            protocol_version=current.payload["protocolVersion"],
            model_id=current.payload["model"],
            input_hash=hashlib.sha256(
                json.dumps(
                    current.payload,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest(),
            metric_snapshot=snapshot.model_dump(mode="json"),
            output=output.model_dump(mode="json"),
        )
        db.add(report)
        db.flush()
        for proposal in output.proposals:
            db.add(
                ImprovementProposal(
                    owner_id=current.owner_id,
                    review_report_id=report.id,
                    title=proposal.title,
                    hypothesis=proposal.hypothesis,
                    change_type=proposal.change_type,
                    direction=proposal.direction,
                    source_sample_ids=proposal.source_sample_ids,
                    status="DRAFT",
                )
            )
        db.add(
            Outbox(
                owner_id=current.owner_id,
                event_type="review.updated",
                aggregate_id=report.id,
                payload={
                    "schemaVersion": "review-notification.v1",
                    "reviewReportId": report.id,
                    "reviewDate": snapshot.review_date.isoformat(),
                    "proposalCount": len(output.proposals),
                },
            )
        )
        return {"reviewReportId": report.id}

    jobs.finish(job, publish=publish)
    return True


def main():
    while True:
        try:
            processed = process_one()
        except Exception:
            print("复盘Worker暂时失败，等待任务租约恢复", flush=True)
            processed = False
        if not processed:
            time.sleep(1)


if __name__ == "__main__":
    main()
