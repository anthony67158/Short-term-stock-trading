from typing import Literal

from pydantic import AwareDatetime, Field

from platform_app.contracts.base import Contract, DecimalString, InstrumentId, Price


class InstrumentView(Contract):
    id: InstrumentId
    code: str
    exchange: Literal["SH", "SZ", "BJ"]
    name: str = Field(min_length=1, max_length=80)
    board: Literal["MAIN", "STAR", "CHINEXT", "BEIJING", "UNKNOWN"]
    first_seen_at: AwareDatetime
    last_seen_at: AwareDatetime
    is_current: bool
    execution_supported: bool = False
    history_status: Literal["CURRENT_ONLY"] = "CURRENT_ONLY"


class UniverseView(Contract):
    id: str
    source: str
    source_url: str
    count: int
    content_hash: str
    acquired_at: AwareDatetime


class InstrumentPage(Contract):
    instruments: list[InstrumentView]
    next_cursor: str | None
    universe: UniverseView | None


class QuoteView(Contract):
    instrument_id: InstrumentId
    name: str
    price: Price | None
    previous_close: Price | None
    open: Price | None
    high: Price | None
    low: Price | None
    change_ratio: DecimalString | None
    quoted_at: AwareDatetime
    received_at: AwareDatetime
    source: Literal["腾讯财经"] = "腾讯财经"
    source_url: str
    freshness: Literal["RECENT", "STALE"]
    missing_reason: str | None = None
    execution_eligible: Literal[False] = False


class WatchInput(Contract):
    instrument_id: InstrumentId


class WatchPage(Contract):
    instruments: list[InstrumentView]
    next_cursor: str | None
