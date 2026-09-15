from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

import pytest

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.portfolio import corrections, executions, reconciliation, service
from platform_app.modules.portfolio.contracts import CashFlowInput
from platform_app.modules.portfolio.correction_contracts import CorrectionCommit, CorrectionInput
from platform_app.modules.portfolio.models import Execution, PositionLot
from test_executions import fact, ledger  # noqa: F401


def prepared(owner, account, trade_id, version):
    body = CorrectionInput(reason="合成交割单误录", expected_version=version)
    preview = corrections.preview_correction(owner, account, trade_id, body)
    return CorrectionCommit(**body.model_dump(), preview_hash=preview.preview_hash)


def test_correction_atomic_replay_receipts_and_source_identity(ledger):  # noqa: F811
    owner, account = ledger
    first = executions.record_execution(owner, account, fact(qty=100, day=3), new_id())
    second = executions.record_execution(owner, account, fact(
        version=3, qty=100, day=2, price="12"), new_id())
    sale_body, sale_key = fact(version=4, side="SELL", qty=40, day=1, price="15"), new_id()
    sale = executions.record_execution(owner, account, sale_body, sale_key)
    assert sale.realized_pnl == Decimal("193")
    commit = prepared(owner, account, first.id, 5)
    key = new_id()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: corrections.correct_execution(
            owner, account, first.id, commit, key), range(4)))
    assert len({row.id for row in results}) == 1
    assert service.balance(owner, account).account.version == 6
    assert service.balance(owner, account).cash_balance == Decimal("9390")
    history = executions.execution_history(owner, account, None, 50).executions
    assert history[0].realized_pnl == Decimal("113")
    assert history[-1].correction_id == results[0].id
    assert executions.record_execution(owner, account, sale_body, sale_key).realized_pnl == 193
    with sessions()() as db:
        original = db.get(Execution, first.id)
        assert original.quantity_shares == 100 and original.price == Decimal("10")
        assert original.cash_delta == Decimal("-1005")
        assert db.get(PositionLot, second.id).remaining_quantity == 60
    assert reconciliation.reconcile(owner, account).matches
    # Corrections do not move the fact-entry clock forward to their recording timestamp.
    executions.record_execution(owner, account, fact(
        version=6, side="SELL", qty=60, day=0), new_id())
    assert reconciliation.reconcile(owner, account).matches
    with pytest.raises(service.PortfolioError, match="不同冲正"):
        corrections.correct_execution(owner, account, second.id, commit, key)
    with pytest.raises(service.PortfolioError, match="已冲正"):
        corrections.preview_correction(owner, account, first.id, CorrectionInput(
            reason="再次冲正", expected_version=7))
    assert len(corrections.correction_history(owner, account, None, 1).corrections) == 1


def test_correction_rejects_dependent_sales_stale_preview_and_unauthorized(ledger):  # noqa: F811
    owner, account = ledger
    buy = executions.record_execution(owner, account, fact(), new_id())
    preview = prepared(owner, account, buy.id, 3)
    sale = executions.record_execution(owner, account, fact(
        version=3, side="SELL", qty=10, day=1), new_id())
    with pytest.raises(service.PortfolioError, match="新记录"):
        corrections.correct_execution(owner, account, buy.id, preview, new_id())
    with pytest.raises(service.PortfolioError, match="缺少可卖股份"):
        prepared(owner, account, buy.id, 4)
    with pytest.raises(service.PortfolioError) as caught:
        prepared(new_id(), account, sale.id, 4)
    assert caught.value.status == 404
    assert service.balance(owner, account).account.version == 4
    commit = prepared(owner, account, sale.id, 4)
    corrections.correct_execution(owner, account, sale.id, commit, new_id())
    assert reconciliation.reconcile(owner, account).matches
    assert executions.positions(owner, account, None, 50).positions[0].quantity_shares == 100


def test_correction_rejects_historical_cash_deficit_and_projection_drift(ledger):  # noqa: F811
    owner, account = ledger
    buy = executions.record_execution(owner, account, fact(qty=900, day=3), new_id())
    sale = executions.record_execution(owner, account, fact(
        version=3, side="SELL", qty=900, day=2, price="12"), new_id())
    service.record_cash(owner, account, CashFlowInput(
        kind="WITHDRAWAL", amount="10000", effective_at=utcnow() - timedelta(days=1),
        source="合成出金", expected_version=4), new_id())
    with pytest.raises(service.PortfolioError, match="现金越界"):
        prepared(owner, account, sale.id, 5)
    assert service.balance(owner, account).account.version == 5
    with sessions().begin() as db:
        db.get(PositionLot, buy.id).remaining_quantity = 1
    with pytest.raises(service.PortfolioError, match="核对差异"):
        prepared(owner, account, sale.id, 5)
    assert not reconciliation.reconcile(owner, account).matches


def test_reversed_source_cannot_be_reimported(ledger):  # noqa: F811
    owner, account = ledger
    body, key = fact(), new_id()
    trade = executions.record_execution(owner, account, body, key)
    commit = prepared(owner, account, trade.id, 3)
    with pytest.raises(service.PortfolioError, match="预览已变化"):
        corrections.correct_execution(owner, account, trade.id, commit.model_copy(
            update={"preview_hash": "0" * 64}), new_id())
    corrections.correct_execution(owner, account, trade.id, commit, new_id())
    assert executions.record_execution(owner, account, body, key) == trade
    with pytest.raises(service.PortfolioError, match="已冲正"):
        executions.record_execution(owner, account, body, new_id())
    report = reconciliation.reconcile(owner, account)
    assert report.matches and report.correction_count == 1 and report.open_lot_count == 0
