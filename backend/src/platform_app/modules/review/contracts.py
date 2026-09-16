from datetime import date
from typing import Literal

from pydantic import AwareDatetime, Field, JsonValue, model_validator

from platform_app.contracts.base import Contract

REVIEW_PROTOCOL_VERSION = "review-agent.v1"
ChangeType = Literal[
    "DECISION_THRESHOLD",
    "AGENT_PROTOCOL",
    "RISK_PARAMETER",
    "FEATURE_SET",
    "EXECUTION_POLICY",
]
Direction = Literal["INCREASE", "DECREASE", "ADD", "REMOVE", "REVIEW"]


class ReviewRunInput(Contract):
    review_date: date


class ReviewMetric(Contract):
    metric_id: str = Field(min_length=1, max_length=120)
    label: str = Field(min_length=1, max_length=120)
    value: str = Field(min_length=1, max_length=80)
    unit: Literal["COUNT", "RETURN", "RATE"]
    source_sample_ids: list[str] = Field(max_length=50)


class FailureCluster(Contract):
    cluster_id: str = Field(min_length=1, max_length=120)
    category: Literal["STRATEGY", "EXECUTION", "DATA"]
    label: str = Field(min_length=1, max_length=160)
    sample_count: int = Field(strict=True, ge=1)
    strategy_failure_eligible: bool
    source_sample_ids: list[str] = Field(min_length=1, max_length=50)


class ReviewMetricSnapshot(Contract):
    schema_version: Literal["review-metric-snapshot.v1"] = (
        "review-metric-snapshot.v1"
    )
    review_date: date
    matured_samples: int = Field(strict=True, ge=0)
    excluded_samples: int = Field(strict=True, ge=0)
    source_dataset_ids: list[str]
    metrics: list[ReviewMetric]
    failure_clusters: list[FailureCluster]


class ReviewConclusion(Contract):
    kind: Literal["OBSERVED", "HYPOTHESIS"]
    statement: str = Field(min_length=1, max_length=1200)
    metric_refs: list[str] = Field(min_length=1, max_length=12)
    source_sample_ids: list[str] = Field(max_length=20)


class ReviewProposalOutput(Contract):
    title: str = Field(min_length=1, max_length=160)
    hypothesis: str = Field(min_length=1, max_length=1200)
    change_type: ChangeType
    direction: Direction
    source_sample_ids: list[str] = Field(min_length=1, max_length=20)


class ReviewAgentOutput(Contract):
    summary: str = Field(min_length=1, max_length=2000)
    conclusions: list[ReviewConclusion] = Field(min_length=1, max_length=12)
    proposals: list[ReviewProposalOutput] = Field(max_length=5)


class ImprovementProposalView(Contract):
    id: str
    review_report_id: str
    title: str
    hypothesis: str
    change_type: ChangeType
    direction: Direction
    source_sample_ids: list[str]
    status: Literal["DRAFT", "COMPILED", "REJECTED"]
    compiled_strategy_version_id: str | None
    created_at: AwareDatetime


class ReviewReportView(Contract):
    id: str
    job_id: str
    review_date: date
    protocol_version: str
    model_id: str
    metric_snapshot: ReviewMetricSnapshot
    output: ReviewAgentOutput
    proposals: list[ImprovementProposalView]
    created_at: AwareDatetime


class ReviewReportPage(Contract):
    reports: list[ReviewReportView]


class ReviewCapability(Contract):
    available: bool
    model: str
    reason: str | None


class StrategyCompilationInput(Contract):
    base_strategy_version_id: str | None = Field(
        default=None,
        min_length=32,
        max_length=32,
    )


class StrategyAgentOutput(Contract):
    status: Literal["PROPOSED", "REJECTED"]
    rationale: str = Field(min_length=1, max_length=1200)
    parameter_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=120,
    )
    candidate_value: JsonValue | None = None

    @model_validator(mode="after")
    def terminal_shape(self):
        proposed = self.status == "PROPOSED"
        if proposed != (self.parameter_id is not None):
            raise ValueError("提案状态与参数不一致")
        if proposed != (self.candidate_value is not None):
            raise ValueError("提案状态与参数值不一致")
        return self


class CycleSupport(Contract):
    horizon: Literal["5_TRADING_DAYS", "20_TRADING_DAYS"]
    status: Literal["ACTIVE", "UNSUPPORTED"]
    reason_code: str | None = None


class DriftMetric(Contract):
    metric_id: str
    baseline_value: str | None
    current_value: str | None
    delta: str | None
    threshold: str | None
    drifted: bool | None


class CycleDriftReportView(Contract):
    id: str
    baseline_date: date | None
    current_date: date
    status: Literal["STABLE", "WARNING", "UNSUPPORTED"]
    comparison_key: str
    metrics: list[DriftMetric]
    blocker_codes: list[str]
    cycle_support: list[CycleSupport]
    created_at: AwareDatetime


class CycleDriftReportPage(Contract):
    reports: list[CycleDriftReportView]
