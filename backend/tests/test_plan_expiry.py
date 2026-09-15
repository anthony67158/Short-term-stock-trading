# ruff: noqa: F811
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from sqlalchemy import select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.portfolio import executions, plans, reconciliation, service
from platform_app.modules.portfolio.models import ExecutionPlan, PlanEvent
from test_executions import fact, ledger  # noqa: F401
from test_plans import plan_input


def test_expiry_is_once_audited_and_late_fill_never_reserves_again(ledger, monkeypatch):
    owner, account = ledger
    plan = plans.create_plan(owner, account, plan_input(), new_id())
    after = plan.expires_at + timedelta(seconds=1)
    monkeypatch.setattr(plans, "utcnow", lambda: after)
    # Read-side release does not mutate version or depend on worker health.
    assert plans.list_plans(owner, account, None, 50).reserved_cash == 0
    assert service.balance(owner, account).account.version == 3
    with ThreadPoolExecutor(max_workers=3) as pool:
        assert sum(pool.map(lambda _: plans.expire_due(), range(3))) == 1
    assert service.balance(owner, account).account.version == 4
    with sessions()() as db:
        row = db.get(ExecutionPlan, plan.id)
        assert row.status == "EXPIRED" and row.reserved_cash == 0
        events = list(db.scalars(select(PlanEvent).where(PlanEvent.plan_id == plan.id)
                                .order_by(PlanEvent.revision)))
        assert [event.kind for event in events] == ["CREATE", "EXPIRE"]
    assert reconciliation.reconcile(owner, account).matches
    # Late reporting of a real earlier fill is valid; expiry remains in audit.
    executions.record_execution(owner, account, fact(version=4, qty=37, day=0).model_copy(
        update={"plan_id": plan.id, "executed_at": utcnow()}), new_id())
    current = plans.list_plans(owner, account, None, 50).plans[0]
    assert current.status == "EXPIRED" and current.recorded_shares == 37
    assert current.reserved_cash == 0
    assert reconciliation.reconcile(owner, account).matches
