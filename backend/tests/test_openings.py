# ruff: noqa: F811
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.kernel.trading import trading_date
from platform_app.modules.portfolio import corrections, executions, openings, reconciliation, service
from platform_app.modules.portfolio.correction_contracts import CorrectionCommit, CorrectionInput
from platform_app.modules.portfolio.models import Execution, PositionLot
from platform_app.modules.portfolio.opening_contracts import OpeningInput
from test_executions import fact, ledger  # noqa: F401


def initial(version=2, quantity=37):
    return OpeningInput(
        instrument_id="SZ.000001", quantity_shares=quantity, cost_basis="375.01",
        acquired_date=trading_date(utcnow()) - timedelta(days=10),
        effective_at=utcnow() - timedelta(days=3),
        source_key=new_id(), source="合成券商期初持仓凭据", expected_version=version,
    )


def test_opening_concurrent_receipt_sale_and_reversal(ledger):
    owner, account = ledger
    body, key = initial(), new_id()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(
            lambda _: openings.record_opening(owner, account, body, key), range(4)))
    assert len({row.id for row in results}) == 1
    assert service.balance(owner, account).cash_balance == Decimal("10000")
    with sessions()() as db:
        assert db.scalar(select(Execution).where(Execution.account_id == account)) is None
    sale = executions.record_execution(
        owner, account, fact(version=3, side="SELL", qty=12, day=1, price="12", fee="1"), new_id())
    assert sale.realized_pnl == Decimal("21.38")
    assert executions.positions(owner, account, None, 50).positions[0].remaining_basis == (
        Decimal("253.39"))
    assert reconciliation.reconcile(owner, account).matches
    body = CorrectionInput(reason="合成错误卖出撤销", expected_version=4)
    preview = corrections.preview_correction(owner, account, sale.id, body)
    corrections.correct_execution(owner, account, sale.id, CorrectionCommit(
        **body.model_dump(), preview_hash=preview.preview_hash), new_id())
    report = reconciliation.reconcile(owner, account)
    assert report.matches and report.opening_lot_count == 1
    assert service.balance(owner, account).cash_balance == Decimal("10000")
    assert executions.positions(owner, account, None, 50).positions[0].remaining_basis == (
        Decimal("375.01"))
    with sessions().begin() as db:
        lot = db.scalar(select(PositionLot).where(PositionLot.account_id == account))
        lot.remaining_basis += Decimal("0.01")
    assert not reconciliation.reconcile(owner, account).matches


def test_opening_duplicate_ownership_and_time_guards(ledger):
    owner, account = ledger
    body = initial()
    openings.record_opening(owner, account, body, new_id())
    with pytest.raises(service.PortfolioError, match="凭据已经"):
        openings.record_opening(owner, account, body.model_copy(update={"expected_version": 3}),
                                new_id())
    with pytest.raises(service.PortfolioError) as error:
        openings.record_opening(new_id(), account, initial(3), new_id())
    assert error.value.status == 404
    with pytest.raises(service.PortfolioError, match="取得日"):
        openings.record_opening(owner, account, initial(3).model_copy(update={
            "acquired_date": trading_date(utcnow())}), new_id())
    with pytest.raises(service.PortfolioError, match="顺序"):
        executions.record_execution(owner, account, fact(version=3, day=3), new_id())
    executions.record_execution(owner, account, fact(version=3, day=1), new_id())
    with pytest.raises(service.PortfolioError, match="已有成交"):
        openings.record_opening(owner, account, initial(4), new_id())
    assert reconciliation.reconcile(owner, account).matches


def test_opening_mixed_settlement_lots_skip_locked(ledger):
    owner, account = ledger
    now = utcnow() - timedelta(seconds=5)
    locked = initial().model_copy(update={
        "acquired_date": trading_date(now), "effective_at": now, "quantity_shares": 100})
    openings.record_opening(owner, account, locked, new_id())
    settled = initial(3).model_copy(update={"effective_at": now, "quantity_shares": 100})
    openings.record_opening(owner, account, settled, new_id())
    sale = fact(version=4, side="SELL", qty=100, day=0).model_copy(
        update={"executed_at": utcnow()})
    executions.record_execution(owner, account, sale, new_id())
    assert reconciliation.reconcile(owner, account).matches
    position = executions.positions(owner, account, None, 50).positions[0]
    assert position.quantity_shares == position.locked_shares == 100
