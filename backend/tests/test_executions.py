import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy import delete, func, select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.identity.models import User
from platform_app.modules.identity.service import create_user
from platform_app.modules.market.models import Instrument
from platform_app.modules.operations.models import Outbox
from platform_app.modules.portfolio import executions, service
from platform_app.modules.portfolio.contracts import AccountInput, CashFlowInput
from platform_app.modules.portfolio.execution_contracts import ExecutionInput
from platform_app.modules.portfolio.models import (
    Account, CashEntry, CustodyTransfer, Execution, ExecutionCommand, ExecutionCorrection, ExecutionImport,
    ExecutionPlan, LotConsumption, OpeningLot, PlanEvent, PositionLot,
)


@pytest.fixture
def ledger():
    owner = create_user("execution-test-" + new_id(), secrets.token_urlsafe(24))
    with sessions().begin() as db:
        if not db.get(Instrument, "SZ.000001"):
            db.add(Instrument(id="SZ.000001", code="000001", name="合成证券", exchange="SZ",
                              board="MAIN", first_seen_at=utcnow(), last_seen_at=utcnow()))
    account = service.create_account(owner, AccountInput(
        name="成交合成测试", kind="SIMULATED", max_position_percent=20,
    ), new_id())
    service.record_cash(owner, account.id, CashFlowInput(
        kind="OPENING", amount="10000", effective_at=utcnow() - timedelta(days=4),
        source="合成期初", expected_version=1,
    ), new_id())
    yield owner, account.id
    with sessions().begin() as db:
        ids = select(Execution.id).where(Execution.account_id == account.id)
        db.execute(delete(LotConsumption).where(LotConsumption.sell_execution_id.in_(ids)))
        db.execute(delete(PositionLot).where(PositionLot.account_id == account.id))
        db.execute(delete(CustodyTransfer).where(CustodyTransfer.account_id == account.id))
        db.execute(delete(OpeningLot).where(OpeningLot.account_id == account.id))
        db.execute(delete(ExecutionCommand).where(ExecutionCommand.account_id == account.id))
        db.execute(delete(CashEntry).where(CashEntry.account_id == account.id))
        db.execute(delete(ExecutionCorrection).where(ExecutionCorrection.account_id == account.id))
        db.execute(delete(Execution).where(Execution.account_id == account.id))
        db.execute(delete(ExecutionImport).where(ExecutionImport.account_id == account.id))
        db.execute(delete(PlanEvent).where(PlanEvent.account_id == account.id))
        db.execute(delete(ExecutionPlan).where(ExecutionPlan.account_id == account.id))
        db.execute(delete(Account).where(Account.id == account.id))
        db.execute(delete(Outbox).where(Outbox.owner_id == owner))
        db.execute(delete(User).where(User.id == owner))


def fact(version=2, side="BUY", qty=100, day=2, price="10", fee="5"):
    return ExecutionInput(
        instrument_id="SZ.000001", source_key=new_id(), side=side,
        quantity_shares=qty, price=price, executed_at=utcnow() - timedelta(days=day, seconds=10),
        fees={"commission": fee, "stampTax": "0", "transferFee": "0", "otherFee": "0"},
        source="合成交割记录", expected_version=version,
    )


def test_execution_atomic_idempotent_fifo_and_realized(ledger):
    owner, account = ledger
    body, key = fact(qty=37), new_id()  # Real partial fills need not be a board lot.
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: executions.record_execution(owner, account, body, key),
                                range(4)))
    assert len({row.id for row in results}) == 1
    assert results[0].cash_delta == Decimal("-375.00")
    repeated = body.model_copy(update={"expected_version": 3})
    duplicate_key = new_id()
    assert executions.record_execution(owner, account, repeated, duplicate_key).id == results[0].id
    with pytest.raises(service.PortfolioError, match="不同成交"):
        executions.record_execution(owner, account, fact(version=3), duplicate_key)
    with pytest.raises(service.PortfolioError, match="不同成交"):
        executions.record_execution(owner, account, body.model_copy(update={"price": Decimal("11")}),
                                    new_id())
    sale = executions.record_execution(owner, account, fact(
        version=3, side="SELL", qty=12, day=1, price="12", fee="1",
    ), new_id())
    assert sale.cash_delta == Decimal("143")
    assert sale.realized_pnl == Decimal("21.38")
    view = executions.positions(owner, account, None, 50)
    assert view.positions[0].remaining_basis == Decimal("253.38")
    assert view.positions[0].quantity_shares == 25
    assert service.balance(owner, account).cash_balance == Decimal("9768")
    last = executions.record_execution(owner, account, fact(
        version=4, side="SELL", qty=25, day=0, price="12", fee="1",
    ), new_id())
    assert last.realized_pnl == Decimal("45.62")
    assert executions.positions(owner, account, None, 50).positions == []
    assert service.balance(owner, account).cash_balance == Decimal("10067")
    page = executions.execution_history(owner, account, None, 1)
    assert page.executions[0].id == last.id
    assert executions.execution_history(owner, account, int(page.next_cursor), 5).executions
    with sessions()() as db:
        assert db.scalar(select(func.count()).select_from(CashEntry).where(
            CashEntry.account_id == account)) == 4
        assert db.scalar(select(func.count()).select_from(Outbox).where(
            Outbox.aggregate_id == account)) == 4


def test_t1_cash_ordering_and_unauthorized_leave_no_partial_write(ledger):
    owner, account = ledger
    body = fact(day=0)
    executions.record_execution(owner, account, body, new_id())
    assert executions.positions(owner, account, None, 50).positions[0].locked_shares == 100
    for bad in [
        fact(version=3, side="SELL", day=0), fact(version=3, day=0, price="10000"),
        fact(version=3, day=2), fact(version=3, day=-1),
    ]:
        with pytest.raises(service.PortfolioError):
            executions.record_execution(owner, account, bad, new_id())
        assert service.balance(owner, account).account.version == 3
        assert service.balance(owner, account).cash_balance == Decimal("8995")
    with pytest.raises(service.PortfolioError) as error:
        executions.positions(new_id(), account, None, 50)
    assert error.value.status == 404
    with pytest.raises(service.PortfolioError):
        executions.record_execution(new_id(), account, fact(version=3), new_id())
