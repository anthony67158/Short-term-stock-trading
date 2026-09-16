from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, model_validator

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


class DecisionPlanInput(Contract):
    expected_version: int = Field(strict=True, ge=1)


class PlanView(Contract):
    id: str
    decision_id: str | None = None
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
    source: Literal["USER", "SYSTEM_DECISION"] = "USER"
    scope: Literal["MANUAL_LEDGER_PLAN", "JOINT_DECISION_PLAN"] = (
        "MANUAL_LEDGER_PLAN"
    )
    execution_eligibility: Literal[
        "NOT_ASSESSED",
        "USER_CONFIRMED",
    ] = "NOT_ASSESSED"

    @model_validator(mode="after")
    def derive_scope(self):
        if self.source == "SYSTEM_DECISION":
            self.scope = "JOINT_DECISION_PLAN"
            self.execution_eligibility = "USER_CONFIRMED"
        return self


class PlanPage(Contract):
    plans: list[PlanView]
    next_cursor: str | None
    account_version: int
    reserved_cash: Money
    spendable_cash: Money
