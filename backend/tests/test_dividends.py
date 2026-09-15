# ruff: noqa: F811
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.portfolio import openings, reconciliation, service
from platform_app.modules.portfolio.contracts import CashFlowInput
from platform_app.modules.portfolio.models import CashEntry
from test_executions import ledger  # noqa: F401
from test_openings import initial


def dividend(version=3, kind="CASH_DIVIDEND", amount="12.34"):
    return CashFlowInput(
        kind=kind, amount=amount, effective_at=utcnow() - timedelta(seconds=1),
        source="合成已结算分红凭据", expected_version=version,
        instrument_id="SZ.000001", corporate_source_key=new_id(),
    )


def test_actual_dividend_and_tax_are_not_external_cash_or_cost_adjustments(ledger):
    owner, account = ledger
    openings.record_opening(owner, account, initial(), new_id())
    body, key = dividend(), new_id()
    with ThreadPoolExecutor(max_workers=3) as pool:
        rows = list(pool.map(lambda _: service.record_cash(owner, account, body, key), range(3)))
    assert len({row.id for row in rows}) == 1
    tax = service.record_cash(owner, account, dividend(4, "DIVIDEND_TAX", "2.47"), new_id())
    assert tax.amount == Decimal("-2.47")
    assert service.balance(owner, account).cash_balance == Decimal("10009.87")
    report = reconciliation.reconcile(owner, account)
    assert report.matches and report.execution_count == 0
    assert openings.opening_history(owner, account, None, 5).lots[0].cost_basis == Decimal("375.01")
    with sessions()() as db:
        kinds = list(db.scalars(select(CashEntry.kind).where(CashEntry.account_id == account)
                               .order_by(CashEntry.account_version)))
    assert kinds == ["OPENING", "CASH_DIVIDEND", "DIVIDEND_TAX"]
    with pytest.raises(service.PortfolioError, match="凭据已入账"):
        service.record_cash(owner, account, body.model_copy(update={"expected_version": 5}), new_id())
    with pytest.raises(service.PortfolioError, match="实际补税"):
        service.record_cash(owner, account, dividend(5, "DIVIDEND_TAX", "20000"), new_id())
    assert service.balance(owner, account).account.version == 5


def test_corporate_cash_requires_security_and_statement_reference():
    body = dividend().model_dump()
    for missing in ("instrument_id", "corporate_source_key"):
        with pytest.raises(ValidationError):
            CashFlowInput.model_validate({**body, missing: None})
    with pytest.raises(ValidationError):
        CashFlowInput.model_validate({**body, "kind": "DEPOSIT"})
