from typing import Annotated, Literal

from pydantic import AwareDatetime, Field

from platform_app.contracts.base import Contract, InstrumentId, Money, Price, Quantity

PlanStatus = Literal["CONFIRMED", "PARTIALLY_RECORDED", "COMPLETED", "CANCELLED", "EXPIRED", "INVALIDATED"]


class PlanInput(Contract):
    instrument_id: InstrumentId
    side: Literal["BUY", "SELL"]
    quantity_shares: Annotated[Quantity, Field(gt=0)]
    limit_price: Price
    fee_budget: Annotated[Money, Field(ge=0)]
    expires_at: AwareDatetime
    reason: str = Field(min_length=1, max_length=300, pattern=r"\S")
    expected_version: int = Field(strict=True, ge=1)


class PlanCancel(Contract):
    expected_version: int = Field(strict=True, ge=1)
    expected_revision: int = Field(strict=True, ge=1)
    reason: str = Field(min_length=1, max_length=300, pattern=r"\S")


class PlanView(Contract):
    id: str
    instrument_id: InstrumentId
    side: Literal["BUY", "SELL"]
    quantity_shares: Quantity
    limit_price: Price
    fee_budget: Money
    recorded_shares: Quantity
    reserved_cash: Money
    reserved_shares: Quantity
    status: PlanStatus
    revision: int
    reason: str
    expires_at: AwareDatetime
    created_at: AwareDatetime
    source: Literal["USER"] = "USER"
    scope: Literal["MANUAL_LEDGER_PLAN"] = "MANUAL_LEDGER_PLAN"
    execution_eligibility: Literal["NOT_ASSESSED"] = "NOT_ASSESSED"


class PlanPage(Contract):
    plans: list[PlanView]
    next_cursor: str | None
    account_version: int
    reserved_cash: Money
    spendable_cash: Money
