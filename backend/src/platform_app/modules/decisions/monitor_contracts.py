from typing import Literal

from pydantic import AwareDatetime

from platform_app.contracts.base import Contract, InstrumentId


class MonitorUpdate(Contract):
    enabled: bool


class MonitorView(Contract):
    id: str
    account_id: str
    instrument_id: InstrumentId
    decision_id: str
    enabled: bool
    status: Literal["PAUSED", "ACTIVE", "TRIGGERED", "FAILED"]
    next_review_at: AwareDatetime
    last_job_id: str | None
    last_triggered_at: AwareDatetime | None
    updated_at: AwareDatetime


class MonitorPage(Contract):
    monitors: list[MonitorView]
