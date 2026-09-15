from typing import Annotated

from fastapi import APIRouter, Header, Query

from platform_app.contracts.base import Contract, Envelope
from platform_app.modules.identity.routes import CurrentUser
from platform_app.modules.portfolio import executions, reconciliation, service
from platform_app.modules.portfolio.execution_contracts import (
    ExecutionInput, ExecutionPage, ExecutionView, PositionPage,
)
from platform_app.modules.portfolio.contracts import (
    AccountBalance, AccountInput, AccountView, CashEntryView, CashFlowInput, CashPage,
)

router = APIRouter(prefix="/api/v1/accounts", tags=["portfolio"])
CommandKey = Annotated[str, Header(alias="Idempotency-Key", min_length=8, max_length=128)]


class AccountPage(Contract):
    accounts: list[AccountView]
    next_cursor: str | None


@router.post("", response_model=Envelope[AccountView], status_code=201)
def create_account(body: AccountInput, user: CurrentUser, key: CommandKey):
    return Envelope(data=service.create_account(user.id, body, key))


@router.get("", response_model=Envelope[AccountPage])
def list_accounts(
    user: CurrentUser, cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    rows = service.list_accounts(user.id, cursor, limit + 1)
    return Envelope(data=AccountPage(
        accounts=rows[:limit], next_cursor=rows[limit - 1].id if len(rows) > limit else None,
    ))


@router.get("/{account_id}/balance", response_model=Envelope[AccountBalance])
def account_balance(account_id: str, user: CurrentUser):
    return Envelope(data=service.balance(user.id, account_id))


@router.post("/{account_id}/cash-flows", response_model=Envelope[CashEntryView], status_code=201)
def cash_flow(account_id: str, body: CashFlowInput, user: CurrentUser, key: CommandKey):
    return Envelope(data=service.record_cash(user.id, account_id, body, key))


@router.get("/{account_id}/cash-flows", response_model=Envelope[CashPage])
def cash_history(
    account_id: str, user: CurrentUser,
    cursor: Annotated[int | None, Query(ge=1)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    return Envelope(data=service.cash_history(user.id, account_id, cursor, limit))


@router.post("/{account_id}/executions", response_model=Envelope[ExecutionView], status_code=201)
def record_execution(account_id: str, body: ExecutionInput, user: CurrentUser, key: CommandKey):
    return Envelope(data=executions.record_execution(user.id, account_id, body, key))


@router.get("/{account_id}/executions", response_model=Envelope[ExecutionPage])
def execution_history(
    account_id: str, user: CurrentUser,
    cursor: Annotated[int | None, Query(ge=1)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    return Envelope(data=executions.execution_history(user.id, account_id, cursor, limit))


@router.get("/{account_id}/positions", response_model=Envelope[PositionPage])
def positions(
    account_id: str, user: CurrentUser, cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    return Envelope(data=executions.positions(user.id, account_id, cursor, limit))


@router.get("/{account_id}/reconciliation", response_model=Envelope[reconciliation.ReconciliationView])
def reconcile(account_id: str, user: CurrentUser):
    return Envelope(data=reconciliation.reconcile(user.id, account_id))
