from decimal import Decimal

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id
from platform_app.modules.portfolio import executions, reconciliation
from platform_app.modules.portfolio.models import PositionLot
from test_executions import fact, ledger  # noqa: F401


def test_independent_replay_detects_projection_drift(ledger):  # noqa: F811 - pytest fixture injection
    owner, account = ledger
    buy = executions.record_execution(owner, account, fact(qty=37), new_id())
    executions.record_execution(owner, account, fact(
        version=3, side="SELL", qty=12, day=1, price="12", fee="1",
    ), new_id())
    report = reconciliation.reconcile(owner, account)
    assert report.matches
    assert report.cash_balance == report.replay_cash_balance == Decimal("9768")
    assert report.execution_count == 2
    assert report.open_lot_count == 1
    # Deliberately damage only a synthetic projection, leaving immutable facts intact.
    with sessions().begin() as db:
        lot = db.get(PositionLot, buy.id)
        lot.remaining_basis += Decimal("0.01")
        lot.remaining_quantity += 1
    report = reconciliation.reconcile(owner, account)
    assert not report.matches
    assert report.discrepancy_count == 2
    assert {issue.field for issue in report.discrepancies} == {"basis", "quantity"}
    # A check reports the discrepancy; it must not silently overwrite the projection.
    with sessions()() as db:
        assert db.get(PositionLot, buy.id).remaining_quantity == 26
