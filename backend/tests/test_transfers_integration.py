from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

import pytest

from platform_app.contracts.base import new_id, utcnow
from platform_app.kernel.trading import trading_date
from platform_app.modules.portfolio import corrections, executions, reconciliation, service, transfers
from platform_app.modules.portfolio.transfer_contracts import TransferInput
from test_corrections import prepared
from test_executions import fact, ledger  # noqa: F401


def incoming(version=3, day=2):
    return TransferInput(
        instrument_id="SZ.000001", quantity_shares=37, cost_basis="375.01",
        acquired_date=trading_date(utcnow() - timedelta(days=10)),
        effective_at=utcnow() - timedelta(days=day), source_key=new_id(),
        source="合成转托管原始批次", expected_version=version)


def test_transfer_after_trade_no_cash_then_sell_replay(ledger):  # noqa: F811
    owner, account = ledger
    buy = executions.record_execution(owner, account, fact(day=3), new_id())
    body, key = incoming(), new_id()
    with ThreadPoolExecutor(max_workers=3) as pool:
        rows = list(pool.map(lambda _: transfers.record_transfer(owner, account, body, key), range(3)))
    assert len({row.id for row in rows}) == 1
    assert service.balance(owner, account).cash_balance == 8995
    sale = executions.record_execution(owner, account, fact(
        version=4, day=1, qty=112, side="SELL", price="12", fee="1"), new_id())
    assert sale.realized_pnl == Decimal("216.38")
    position = executions.positions(owner, account, None, 30).positions[0]
    assert position.quantity_shares == 25 and position.remaining_basis == Decimal("253.39")
    assert reconciliation.reconcile(owner, account).matches
    corrections.correct_execution(owner, account, sale.id,
                                  prepared(owner, account, sale.id, 5), new_id())
    corrections.correct_execution(owner, account, buy.id,
                                  prepared(owner, account, buy.id, 6), new_id())
    assert executions.positions(owner, account, None, 30).positions[0].quantity_shares == 37
    assert service.balance(owner, account).cash_balance == 10000
    report = reconciliation.reconcile(owner, account)
    assert report.matches and report.transfer_count == 1
    with pytest.raises(service.PortfolioError):
        transfers.transfer_history(new_id(), account, None, 30)


def test_future_transfer_cannot_cover_prior_sale_during_correction(ledger):  # noqa: F811
    owner, account = ledger
    buy = executions.record_execution(owner, account, fact(day=3, qty=37), new_id())
    executions.record_execution(owner, account, fact(
        version=3, day=2, qty=37, side="SELL", price="12"), new_id())
    transfers.record_transfer(owner, account, incoming(version=4, day=1), new_id())
    with pytest.raises(service.PortfolioError, match="缺少可卖股份"):
        prepared(owner, account, buy.id, 5)
    assert reconciliation.reconcile(owner, account).matches
