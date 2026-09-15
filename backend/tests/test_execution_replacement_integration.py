"""Database integration coverage for correction dependencies and immutable facts."""
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import pytest

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id
from platform_app.modules.portfolio import corrections, executions, plans, reconciliation, service
from platform_app.modules.portfolio.correction_contracts import CorrectionCommit, CorrectionInput
from platform_app.modules.portfolio.models import Execution
from test_executions import fact, ledger  # noqa: F401
from test_plans import plan_input


def replacement(qty=100, price="11"):
    return {"quantity_shares": qty, "price": price,
            "fees": {"commission": "5", "stamp_tax": "0", "transfer_fee": "0", "other_fee": "0"}}


def test_replacement_replays_dependent_sale_and_preserves_original(ledger):  # noqa: F811
    owner, account = ledger
    original, key = fact(day=3), new_id()
    buy = executions.record_execution(owner, account, original, key)
    sale = executions.record_execution(owner, account, fact(
        version=3, side="SELL", qty=40, day=2, price="15"), new_id())
    body = CorrectionInput(reason="合成凭据价格修订", expected_version=4,
                           replacement=replacement())
    preview = corrections.preview_correction(owner, account, buy.id, body)
    assert preview.cash_after == Decimal("9490") and preview.recalculated_sales == 1
    commit = CorrectionCommit(**body.model_dump(), preview_hash=preview.preview_hash)
    correction_key = new_id()
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(lambda _: corrections.correct_execution(
            owner, account, buy.id, commit, correction_key), range(4)))
    assert len({row.id for row in rows}) == 1
    assert rows[0].reversal_amount == -100
    assert executions.record_execution(owner, account, original, key) == buy
    with sessions()() as db:
        assert db.get(Execution, buy.id).price == 10
        assert db.get(Execution, buy.id).quantity_shares == 100
        assert db.get(Execution, sale.id).realized_pnl == Decimal("153")
    position = executions.positions(owner, account, None, 30).positions[0]
    assert position.quantity_shares == 60 and position.remaining_basis == Decimal("663")
    assert reconciliation.reconcile(owner, account).matches
    # A subsequent unrelated void must preserve the earlier replacement.
    body = CorrectionInput(reason="合成卖出作废", expected_version=5)
    preview = corrections.preview_correction(owner, account, sale.id, body)
    corrections.correct_execution(owner, account, sale.id, CorrectionCommit(
        **body.model_dump(), preview_hash=preview.preview_hash), new_id())
    assert service.balance(owner, account).cash_balance == Decimal("8895")
    assert executions.positions(owner, account, None, 30).positions[0].remaining_basis == 1105
    assert reconciliation.reconcile(owner, account).matches


def test_replacement_rejects_short_shares_deficit_and_changed_confirmation(ledger):  # noqa: F811
    owner, account = ledger
    buy = executions.record_execution(owner, account, fact(day=3), new_id())
    executions.record_execution(owner, account, fact(
        version=3, side="SELL", qty=40, day=2), new_id())
    for value, message in [(replacement(qty=30), "缺少可卖股份"),
                           (replacement(price="200"), "现金越界")]:
        with pytest.raises(service.PortfolioError, match=message):
            corrections.preview_correction(owner, account, buy.id, CorrectionInput(
                reason="合成错误修订", expected_version=4, replacement=value))
    body = CorrectionInput(reason="合成修订", expected_version=4, replacement=replacement())
    preview = corrections.preview_correction(owner, account, buy.id, body)
    with pytest.raises(service.PortfolioError, match="预览已变化"):
        corrections.correct_execution(owner, account, buy.id, CorrectionCommit(
            reason=body.reason, expected_version=4, replacement=replacement(price="12"),
            preview_hash=preview.preview_hash), new_id())
    assert service.balance(owner, account).account.version == 4
    assert reconciliation.reconcile(owner, account).matches


def test_replacement_updates_plan_remaining_reservation(ledger):  # noqa: F811
    owner, account = ledger
    plan = plans.create_plan(owner, account, plan_input(), new_id())
    buy = executions.record_execution(owner, account, fact(
        version=3, qty=37, day=0).model_copy(update={"plan_id": plan.id}), new_id())
    body = CorrectionInput(reason="合成部分成交更正", expected_version=4,
                           replacement=replacement(qty=40, price="10"))
    preview = corrections.preview_correction(owner, account, buy.id, body)
    corrections.correct_execution(owner, account, buy.id, CorrectionCommit(
        **body.model_dump(), preview_hash=preview.preview_hash), new_id())
    current = plans.list_plans(owner, account, None, 30).plans[0]
    assert current.recorded_shares == 40 and current.reserved_cash == 600
    assert current.status == "PARTIALLY_RECORDED"
    assert service.balance(owner, account).cash_balance == 9595
    assert reconciliation.reconcile(owner, account).matches
