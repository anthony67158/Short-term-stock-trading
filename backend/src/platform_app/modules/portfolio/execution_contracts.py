from typing import Annotated, Literal

from pydantic import AwareDatetime, Field

from platform_app.contracts.base import Contract, InstrumentId, Money, Price, Quantity

NonnegativeMoney = Annotated[Money, Field(ge=0)]


class ActualFees(Contract):
    commission: NonnegativeMoney
    stamp_tax: NonnegativeMoney
    transfer_fee: NonnegativeMoney
    other_fee: NonnegativeMoney
    basis: Literal["ACTUAL"] = "ACTUAL"


class ExecutionInput(Contract):
    instrument_id: InstrumentId
    source_key: str = Field(min_length=1, max_length=128, pattern=r"\S")
    side: Literal["BUY", "SELL"]
    quantity_shares: Annotated[Quantity, Field(gt=0)]
    price: Price
    executed_at: AwareDatetime
    fees: ActualFees
    source: str = Field(min_length=1, max_length=300, pattern=r"\S")
    expected_version: int = Field(strict=True, ge=1)


class ExecutionView(Contract):
    id: str
    instrument_id: InstrumentId
    source_key: str
    side: Literal["BUY", "SELL"]
    quantity_shares: Quantity
    price: Price
    gross_amount: Money
    total_fees: Money
    fees: ActualFees
    cash_delta: Money
    realized_pnl: Money | None
    executed_at: AwareDatetime
    recorded_at: AwareDatetime
    source: str
    account_version: int
    correction_id: str | None = None


class ExecutionPage(Contract):
    executions: list[ExecutionView]
    next_cursor: str | None


class PositionView(Contract):
    instrument_id: InstrumentId
    name: str
    quantity_shares: Quantity
    sellable_shares: Quantity
    locked_shares: Quantity
    remaining_basis: Money
    cost_method: Literal["FIFO_ACTUAL_FEES"] = "FIFO_ACTUAL_FEES"


class PositionPage(Contract):
    positions: list[PositionView]
    next_cursor: str | None
    account_version: int
    as_of: AwareDatetime
