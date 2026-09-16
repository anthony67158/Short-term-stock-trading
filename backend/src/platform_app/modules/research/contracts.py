from typing import Literal

from pydantic import AwareDatetime, Field, HttpUrl, field_validator

from platform_app.contracts.base import Contract, InstrumentId


class EvidenceInput(Contract):
    instrument_id: InstrumentId
    title: str = Field(min_length=1, max_length=200)
    source_url: HttpUrl
    published_at: AwareDatetime
    text: str = Field(min_length=20, max_length=20000)
    quote: str = Field(min_length=10, max_length=3000)

    @field_validator("source_url")
    @classmethod
    def https_only(cls, value):
        if value.scheme != "https" or value.username or value.password:
            raise ValueError("使用不含凭据的HTTPS来源链接")
        return value


class EvidenceView(EvidenceInput):
    id: str
    content_hash: str
    first_seen_at: AwareDatetime
    available_at: AwareDatetime
    provenance: Literal["USER_SUPPLIED", "SEARCH_DISCOVERED"]
    validation: Literal["QUOTE_MATCHED", "SEARCH_RESULT_UNVERIFIED"]


class EvidencePage(Contract):
    evidence: list[EvidenceView]
    next_cursor: str | None


class ResearchInput(Contract):
    instrument_id: InstrumentId
    question: str = Field(min_length=5, max_length=1000)
    evidence_ids: list[str] = Field(max_length=16)


class Claim(Contract):
    kind: Literal["OBSERVED", "INFERRED", "HYPOTHESIS"]
    statement: str = Field(min_length=1, max_length=1500)
    evidence_ids: list[str] = Field(min_length=1, max_length=16)


class AssessmentOutput(Contract):
    summary: str = Field(min_length=1, max_length=2000)
    claims: list[Claim] = Field(min_length=1, max_length=12)
    counter_claims: list[Claim] = Field(max_length=12)
    thesis_status: Literal["SUPPORTED", "WEAKENED", "INVALIDATED", "UNCERTAIN"]
    strategy_fit: list[Literal["TREND", "VALUE", "QUALITY", "EVENT", "RECOVERY"]] = Field(max_length=5)
    uncertainties: list[str] = Field(min_length=1, max_length=12)
    invalidation: str = Field(min_length=1, max_length=2000)
    next_check: str = Field(min_length=1, max_length=1000)
    valid_until: AwareDatetime


class AssessmentView(Contract):
    id: str
    job_id: str
    instrument_id: InstrumentId
    protocol_version: str
    model_id: str
    as_of: AwareDatetime
    created_at: AwareDatetime
    input_hash: str
    evidence_ids: list[str]
    output: AssessmentOutput
    tool_trace: list[dict]
    status: Literal["VALIDATED"] = "VALIDATED"
    usage: Literal["RESEARCH_ONLY"] = "RESEARCH_ONLY"


class AssessmentPage(Contract):
    assessments: list[AssessmentView]
    next_cursor: str | None


class ResearchCapability(Contract):
    available: bool
    model: str
    reason: str | None
    timeout_seconds: int
    search_available: bool
    search_max_calls: int
    tools: list[str]


class JobView(Contract):
    id: str
    kind: str
    status: Literal["QUEUED", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED", "EXPIRED"]
    stage: str
    created_at: AwareDatetime
    updated_at: AwareDatetime
    cancellation_requested: bool
    result: dict | None
    error_code: str | None
    message: str | None = None
