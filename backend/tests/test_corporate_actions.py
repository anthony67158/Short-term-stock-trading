# ruff: noqa: F811
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.portfolio import (
    corporate_actions,
    executions,
    openings,
    reconciliation,
    service,
)
from platform_app.modules.portfolio.corporate_action_contracts import (
    CorporateShareInput,
)
from test_executions import ledger  # noqa: F401
from test_openings import initial


def test_stock_dividend_preserves_basis_and_replays_allocations(ledger):
    owner, account = ledger
    first = openings.record_opening(
        owner,
        account,
        initial(quantity=100),
        new_id(),
    )
    second = openings.record_opening(
        owner,
        account,
        initial(version=3, quantity=300).model_copy(
            update={
                "cost_basis": Decimal("900"),
                "source_key": new_id(),
            }
        ),
        new_id(),
    )
    body = CorporateShareInput(
        kind="STOCK_DIVIDEND",
        instrument_id="SZ.000001",
        quantity_shares=40,
        effective_at=utcnow() - timedelta(days=1),
        source_key=new_id(),
        source="合成券商送股到账凭据",
        expected_version=4,
    )
    key = new_id()
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(
            pool.map(
                lambda _: corporate_actions.record_share_event(
                    owner,
                    account,
                    body,
                    key,
                ),
                range(3),
            )
        )
    assert len({row.id for row in results}) == 1
    event = results[0]
    assert [
        allocation.model_dump()
        for allocation in event.allocations
    ] == [
        {"lot_id": first.id, "quantity_shares": 10},
        {"lot_id": second.id, "quantity_shares": 30},
    ]
    position = executions.positions(
        owner,
        account,
        None,
        10,
    ).positions[0]
    assert position.quantity_shares == 440
    assert position.remaining_basis == Decimal("1275.01")
    assert service.balance(owner, account).cash_balance == Decimal("10000")
    report = reconciliation.reconcile(owner, account)
    assert report.matches
    assert report.corporate_share_event_count == 1
    assert (
        corporate_actions.share_event_history(
            owner,
            account,
            None,
            10,
        ).events[0].id
        == event.id
    )
