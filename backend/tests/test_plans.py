from datetime import timedelta
from decimal import Decimal
from concurrent.futures import ThreadPoolExecutor

import pytest

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.portfolio import corrections, executions, plans, reconciliation, service
from platform_app.modules.portfolio.contracts import CashFlowInput
from platform_app.modules.portfolio.plan_contracts import PlanCancel, PlanInput
from platform_app.modules.portfolio.models import ExecutionPlan
from test_corrections import prepared
from test_executions import fact, ledger  # noqa: F401


def plan_input(version=2, side="BUY", quantity=100, price="10"):
    return PlanInput(
        instrument_id="SZ.000001", side=side, quantity_shares=quantity, limit_price=price,
        fee_budget="5", expires_at=utcnow() + timedelta(minutes=10),
        reason="合成人工计划", expected_version=version,
    )


def test_plan_reservation_partial_fill_cancel_and_fact_priority(ledger):  # noqa: F811
    owner, account = ledger
    body, key = plan_input(), new_id()
    plan = plans.create_plan(owner, account, body, key)
    assert plans.create_plan(owner, account, body, key) == plan
    assert plan.reserved_cash == Decimal("1005")
    assert service.balance(owner, account).cash_balance == 10000
    assert executions.positions(owner, account, None, 50).positions == []
    assert plans.list_plans(owner, account, None, 50).spendable_cash == 8995
    assert reconciliation.reconcile(owner, account).matches
    trade = fact(version=3, qty=37, day=0).model_copy(update={"plan_id": plan.id})
    executions.record_execution(owner, account, trade, new_id())
    current = plans.list_plans(owner, account, None, 50).plans[0]
    assert current.status == "PARTIALLY_RECORDED"
    assert current.recorded_shares == 37 and current.reserved_cash == 630
    assert reconciliation.reconcile(owner, account).matches
    plans.cancel_plan(owner, account, plan.id, PlanCancel(
        expected_version=4, expected_revision=current.revision, reason="合成取消"), new_id())
    assert plans.list_plans(owner, account, None, 50).reserved_cash == 0
    assert executions.positions(owner, account, None, 50).positions[0].quantity_shares == 37
    assert reconciliation.reconcile(owner, account).matches
    # A late actual fill on a cancelled plan is retained, without reviving its reservation.
    executions.record_execution(owner, account, fact(version=5, qty=63, day=0).model_copy(
        update={"plan_id": plan.id}), new_id())
    current = plans.list_plans(owner, account, None, 50).plans[0]
    assert current.status == "CANCELLED" and current.recorded_shares == 100
    assert reconciliation.reconcile(owner, account).matches


def test_reservations_cannot_double_spend_or_credit_unexecuted_sales(ledger):  # noqa: F811
    owner, account = ledger
    executions.record_execution(owner, account, fact(qty=900, day=2), new_id())
    sell = plans.create_plan(owner, account, plan_input(3, "SELL", 900, "12"), new_id())
    assert sell.reserved_cash == 0 and sell.reserved_shares == 900
    with pytest.raises(service.PortfolioError, match="可卖股数不足"):
        plans.create_plan(owner, account, plan_input(4, "SELL", 100), new_id())
    with pytest.raises(service.PortfolioError, match="现金不足"):
        plans.create_plan(owner, account, plan_input(4, "BUY", 100), new_id())
    assert plans.list_plans(owner, account, None, 50).spendable_cash == 995
    executions.record_execution(owner, account, fact(
        version=4, side="SELL", qty=100, day=0), new_id())
    assert plans.list_plans(owner, account, None, 50).plans[0].status == "INVALIDATED"
    assert reconciliation.reconcile(owner, account).matches


def test_withdrawal_invalidates_unfunded_plan_and_rejects_wrong_link(ledger):  # noqa: F811
    owner, account = ledger
    plan = plans.create_plan(owner, account, plan_input(), new_id())
    service.record_cash(owner, account, CashFlowInput(
        kind="WITHDRAWAL", amount="9500", source="合成出金",
        effective_at=utcnow() - timedelta(days=1), expected_version=3), new_id())
    assert plans.list_plans(owner, account, None, 50).plans[0].status == "INVALIDATED"
    assert reconciliation.reconcile(owner, account).matches
    with pytest.raises(service.PortfolioError, match="方向"):
        executions.record_execution(owner, account, fact(
            version=4, side="SELL", day=0).model_copy(update={"plan_id": plan.id}), new_id())
    with pytest.raises(service.PortfolioError) as error:
        plans.list_plans(new_id(), account, None, 50)
    assert error.value.status == 404


def test_plan_completion_correction_and_expiry(ledger):  # noqa: F811
    owner, account = ledger
    plan = plans.create_plan(owner, account, plan_input(), new_id())
    trade = executions.record_execution(owner, account, fact(version=3, day=0).model_copy(
        update={"plan_id": plan.id}), new_id())
    current = plans.list_plans(owner, account, None, 50).plans[0]
    assert current.status == "COMPLETED" and current.reserved_cash == 0
    commit = prepared(owner, account, trade.id, 4)
    corrections.correct_execution(owner, account, trade.id, commit, new_id())
    current = plans.list_plans(owner, account, None, 50).plans[0]
    assert current.status == "INVALIDATED" and current.recorded_shares == 0
    assert reconciliation.reconcile(owner, account).matches
    expiring = plans.create_plan(owner, account, plan_input(version=5), new_id())
    with sessions().begin() as db:
        db.get(ExecutionPlan, expiring.id).expires_at = utcnow() - timedelta(seconds=1)
    view = plans.list_plans(owner, account, None, 50)
    assert view.reserved_cash == 0 and view.spendable_cash == 10000
    assert next(row for row in view.plans if row.id == expiring.id).status == "EXPIRED"


def test_concurrent_plans_use_account_version_and_cannot_overreserve(ledger):  # noqa: F811
    owner, account = ledger
    body = plan_input(quantity=900)

    def attempt(_):
        try:
            return plans.create_plan(owner, account, body, new_id()).id
        except service.PortfolioError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(attempt, range(3)))
    assert results.count("ACCOUNT_VERSION_CONFLICT") == 2
    assert plans.list_plans(owner, account, None, 50).reserved_cash == 9005
    with pytest.raises(service.PortfolioError, match="现金不足"):
        plans.create_plan(owner, account, plan_input(version=3), new_id())
    assert reconciliation.reconcile(owner, account).matches
