from datetime import date
from typing import Annotated

from pydantic import AwareDatetime, Field

from platform_app.contracts.base import Contract, InstrumentId, Money, Quantity


class OpeningInput(Contract):
    instrument_id: InstrumentId
    quantity_shares: Annotated[Quantity, Field(gt=0)]
    cost_basis: Annotated[Money, Field(ge=0, lt=10**18)]
    acquired_date: date
    effective_at: AwareDatetime
    source_key: str = Field(min_length=1, max_length=128, pattern=r"\S")
    source: str = Field(min_length=1, max_length=300, pattern=r"\S")
    expected_version: int = Field(strict=True, ge=1)


class OpeningView(Contract):
    id: str
    instrument_id: InstrumentId
    quantity_shares: Quantity
    cost_basis: Money
    acquired_date: date
    effective_at: AwareDatetime
    source_key: str
    source: str
    account_version: int
    recorded_at: AwareDatetime


class OpeningPage(Contract):
    lots: list[OpeningView]
    next_cursor: str | None
