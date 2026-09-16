from typing import Literal

from pydantic import AwareDatetime, Field

from platform_app.contracts.base import Contract, InstrumentId


class CandidateScanInput(Contract):
    limit: int = Field(default=20, ge=1, le=50)


class JointCandidate(Contract):
    instrument_id: InstrumentId
    name: str | None
    board: Literal["MAIN", "CHINEXT", "STAR", "BEIJING"]
    decision_date: str = Field(pattern=r"^\d{8}$")
    recall_sources: list[Literal["MODEL", "AGENT_EVENT"]]
    rank_score: float | None
    expected_gross_return: float | None
    assessment_id: str | None
    thesis_status: Literal[
        "SUPPORTED",
        "WEAKENED",
        "INVALIDATED",
        "UNCERTAIN",
    ] | None
    evidence_ids: list[str]


class CandidateScan(Contract):
    schema_version: Literal["joint-candidate-scan.v1"] = (
        "joint-candidate-scan.v1"
    )
    release_id: str
    release_status: Literal["READY", "SHADOW"]
    as_of: AwareDatetime
    decision_date: str = Field(pattern=r"^\d{8}$")
    market_snapshot_ref: str
    eligible_instruments: int
    model_recall_count: int
    agent_event_recall_count: int
    candidates: list[JointCandidate]
    blocker_codes: list[str]
