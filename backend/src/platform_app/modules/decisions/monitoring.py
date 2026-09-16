import hashlib

from sqlalchemy import select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import utcnow
from platform_app.modules.decisions.models import (
    CurrentDecision,
    DecisionMonitor,
    DecisionRecord,
)
from platform_app.modules.decisions.monitor_contracts import (
    MonitorPage,
    MonitorUpdate,
    MonitorView,
)
from platform_app.modules.decisions.position_contracts import (
    PositionDecision,
    PositionEvaluationInput,
)
from platform_app.modules.operations.models import Job, Outbox
from platform_app.modules.portfolio.service import owned_account


class MonitorError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422):
        self.code, self.message, self.status = code, message, status


def register_decision_monitor(db, owner_id: str, decision: PositionDecision):
    next_review = decision.review_after or decision.valid_until
    monitor = db.scalar(
        select(DecisionMonitor).where(
            DecisionMonitor.account_id == decision.account_id,
            DecisionMonitor.instrument_id == decision.instrument_id,
        )
    )
    if monitor is None:
        monitor = DecisionMonitor(
            owner_id=owner_id,
            account_id=decision.account_id,
            instrument_id=decision.instrument_id,
            decision_id=decision.decision_id,
            enabled=False,
            status="PAUSED",
            next_review_at=next_review,
        )
        db.add(monitor)
        return
    monitor.decision_id = decision.decision_id
    monitor.next_review_at = next_review
    monitor.status = "ACTIVE" if monitor.enabled else "PAUSED"
    monitor.updated_at = utcnow()


def monitors(
    owner_id: str,
    account_id: str,
) -> MonitorPage:
    with sessions()() as db:
        owned_account(db, owner_id, account_id)
        rows = list(
            db.scalars(
                select(DecisionMonitor)
                .where(DecisionMonitor.account_id == account_id)
                .order_by(DecisionMonitor.instrument_id)
            )
        )
        return MonitorPage(
            monitors=[MonitorView.model_validate(row) for row in rows]
        )


def update_monitor(
    owner_id: str,
    decision_id: str,
    body: MonitorUpdate,
) -> MonitorView:
    with sessions().begin() as db:
        decision_row = db.scalar(
            select(DecisionRecord).where(
                DecisionRecord.id == decision_id,
                DecisionRecord.owner_id == owner_id,
            )
        )
        if decision_row is None:
            raise MonitorError(
                "DECISION_NOT_FOUND",
                "决策不存在或无权访问",
                404,
            )
        pointer = db.get(
            CurrentDecision,
            (decision_row.account_id, decision_row.instrument_id),
        )
        if pointer is None or pointer.decision_id != decision_id:
            raise MonitorError(
                "DECISION_SUPERSEDED",
                "只能监控当前有效决策",
                409,
            )
        monitor = db.scalar(
            select(DecisionMonitor)
            .where(
                DecisionMonitor.account_id == decision_row.account_id,
                DecisionMonitor.instrument_id == decision_row.instrument_id,
            )
            .with_for_update()
        )
        if monitor is None:
            decision = PositionDecision.model_validate(decision_row.payload)
            register_decision_monitor(db, owner_id, decision)
            db.flush()
            monitor = db.scalar(
                select(DecisionMonitor).where(
                    DecisionMonitor.account_id == decision_row.account_id,
                    DecisionMonitor.instrument_id
                    == decision_row.instrument_id,
                )
            )
        monitor.enabled = body.enabled
        monitor.status = "ACTIVE" if body.enabled else "PAUSED"
        monitor.updated_at = utcnow()
        return MonitorView.model_validate(monitor)


def _trigger_key(monitor: DecisionMonitor) -> str:
    return hashlib.sha256(
        (
            f"{monitor.id}:{monitor.decision_id}:"
            f"{monitor.next_review_at.isoformat()}"
        ).encode()
    ).hexdigest()


def trigger_due(limit: int = 20) -> int:
    now = utcnow()
    claimed = []
    with sessions().begin() as db:
        rows = list(
            db.scalars(
                select(DecisionMonitor)
                .where(
                    DecisionMonitor.enabled.is_(True),
                    (
                        (
                            DecisionMonitor.status == "ACTIVE"
                        )
                        & (DecisionMonitor.next_review_at <= now)
                    )
                    | (
                        (DecisionMonitor.status == "TRIGGERED")
                        & (DecisionMonitor.last_job_id.is_(None))
                    ),
                )
                .order_by(DecisionMonitor.next_review_at)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        )
        for monitor in rows:
            if monitor.status == "ACTIVE":
                monitor.last_trigger_key = _trigger_key(monitor)
                monitor.last_triggered_at = now
                monitor.status = "TRIGGERED"
            claimed.append(
                (
                    monitor.id,
                    monitor.owner_id,
                    monitor.account_id,
                    monitor.instrument_id,
                    monitor.last_trigger_key,
                )
            )
    from platform_app.modules.decisions.service import (
        DecisionError,
        submit_position_evaluation,
    )

    for monitor_id, owner_id, account_id, instrument_id, trigger_key in claimed:
        try:
            with sessions()() as db:
                account = owned_account(db, owner_id, account_id)
                version = account.version
            job = submit_position_evaluation(
                owner_id,
                account_id,
                PositionEvaluationInput(
                    instrument_id=instrument_id,
                    expected_version=version,
                    reason="服务端监控到达联合复核时间",
                ),
                trigger_key,
            )
        except DecisionError as exc:
            with sessions().begin() as db:
                monitor = db.get(DecisionMonitor, monitor_id)
                if monitor and monitor.last_trigger_key == trigger_key:
                    monitor.status = "FAILED"
                    monitor.updated_at = utcnow()
                    db.add(
                        Outbox(
                            owner_id=owner_id,
                            event_type="monitor.failed",
                            aggregate_id=monitor_id,
                            payload={
                                "monitorId": monitor_id,
                                "errorCode": exc.code,
                            },
                        )
                    )
            continue
        with sessions().begin() as db:
            monitor = db.get(DecisionMonitor, monitor_id)
            if monitor and monitor.last_trigger_key == trigger_key:
                monitor.last_job_id = job.id
                monitor.updated_at = utcnow()
                db.add(
                    Outbox(
                        owner_id=owner_id,
                        event_type="monitor.triggered",
                        aggregate_id=monitor_id,
                        payload={
                            "monitorId": monitor_id,
                            "jobId": job.id,
                            "instrumentId": instrument_id,
                        },
                    )
                )
    return len(claimed)


def mark_failed_jobs(limit: int = 100) -> int:
    with sessions().begin() as db:
        monitors_with_jobs = list(
            db.scalars(
                select(DecisionMonitor)
                .where(
                    DecisionMonitor.status == "TRIGGERED",
                    DecisionMonitor.last_job_id.is_not(None),
                )
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        )
        count = 0
        for monitor in monitors_with_jobs:
            job = db.get(Job, monitor.last_job_id)
            if job and job.status in ("FAILED", "CANCELLED", "EXPIRED"):
                monitor.status = "FAILED"
                monitor.updated_at = utcnow()
                count += 1
        return count
