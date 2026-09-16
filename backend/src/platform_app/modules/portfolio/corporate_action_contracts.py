from typing import Annotated, Literal

from pydantic import AwareDatetime, Field

from platform_app.contracts.base import Contract, InstrumentId, Quantity


class CorporateShareInput(Contract):
    kind: Literal["STOCK_DIVIDEND", "SPLIT"]
    instrument_id: InstrumentId
    quantity_shares: Annotated[Quantity, Field(gt=0)]
    effective_at: AwareDatetime
    source_key: str = Field(min_length=1, max_length=128, pattern=r"\S")
    source: str = Field(min_length=1, max_length=300, pattern=r"\S")
    expected_version: int = Field(strict=True, ge=1)


class ShareAllocation(Contract):
    lot_id: str
    quantity_shares: Annotated[Quantity, Field(gt=0)]


class CorporateShareView(Contract):
    id: str
    kind: Literal["STOCK_DIVIDEND", "SPLIT"]
    instrument_id: InstrumentId
    quantity_shares: Quantity
    effective_at: AwareDatetime
    source_key: str
    source: str
    account_version: int
    allocations: list[ShareAllocation]
    recorded_at: AwareDatetime


class CorporateSharePage(Contract):
    events: list[CorporateShareView]
    next_cursor: str | None
