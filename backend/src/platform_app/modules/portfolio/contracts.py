from typing import Annotated, Literal

from pydantic import AwareDatetime, Field

from platform_app.contracts.base import Contract, Money

IdempotencyKey = Annotated[str, Field(min_length=8, max_length=128)]


class AccountInput(Contract):
    name: str = Field(min_length=1, max_length=80, pattern=r"\S")
    kind: Literal["REAL", "SIMULATED"]
    currency: Literal["CNY"] = "CNY"
    max_position_percent: int = Field(strict=True, ge=1, le=100)


class AccountView(AccountInput):
    id: str
    version: int
    created_at: AwareDatetime


class CashFlowInput(Contract):
    kind: Literal["OPENING", "DEPOSIT", "WITHDRAWAL"]
    amount: Annotated[Money, Field(gt=0)]
    effective_at: AwareDatetime
    source: str = Field(min_length=1, max_length=300, pattern=r"\S")
    expected_version: int = Field(strict=True, ge=1)


class CashEntryView(Contract):
    id: str
    kind: Literal["OPENING", "DEPOSIT", "WITHDRAWAL", "EXECUTION", "REVERSAL"]
    amount: Money
    effective_at: AwareDatetime
    recorded_at: AwareDatetime
    source: str
    account_version: int
    execution_id: str | None = None
    correction_id: str | None = None


class CashPage(Contract):
    entries: list[CashEntryView]
    next_cursor: str | None


class AccountBalance(Contract):
    account: AccountView
    cash_balance: Money
