from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, JsonValue, model_validator

from platform_app.contracts.base import Contract

Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Identifier = Annotated[str, Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9._:-]+$")]


class DatasetReference(Contract):
    dataset_id: Identifier
    sha256: Sha256


class SplitContract(Contract):
    train_end: str = Field(pattern=r"^\d{8}$")
    calibration_start: str = Field(pattern=r"^\d{8}$")
    calibration_end: str = Field(pattern=r"^\d{8}$")
    confirmation_start: str = Field(pattern=r"^\d{8}$")
    confirmation_end: str = Field(pattern=r"^\d{8}$")
    embargo_sessions: int = Field(strict=True, ge=0, le=252)

    @model_validator(mode="after")
    def ordered(self):
        if not (
            self.train_end
            < self.calibration_start
            <= self.calibration_end
            < self.confirmation_start
            <= self.confirmation_end
        ):
            raise ValueError("训练、校准和确认区间必须按时间顺序且互不重叠")
        return self


class StrategyVersionInput(Contract):
    strategy_key: str = Field(
        min_length=1,
        max_length=80,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )
    name: str = Field(min_length=1, max_length=120, pattern=r"\S")
    hypothesis: str = Field(min_length=1, max_length=1000, pattern=r"\S")
    scope: dict[str, JsonValue]
    config: dict[str, JsonValue]
    dataset: DatasetReference
    split: SplitContract
    release_policy: dict[str, JsonValue]
    fee_policy_version: Identifier
    risk_policy_version: Identifier
    simulation_policy_version: Identifier
    confirmation_set_id: Identifier
    minimum_effective_samples: int = Field(strict=True, ge=1, le=1_000_000)


class FreezeStrategyInput(Contract):
    expected_revision: int = Field(strict=True, ge=1)


class StrategyVersionView(Contract):
    id: str
    strategy_key: str
    version: int
    status: Literal["DRAFT", "FROZEN", "EVALUATED"]
    name: str
    hypothesis: str
    scope: dict[str, JsonValue]
    config: dict[str, JsonValue]
    dataset: DatasetReference
    split: SplitContract
    release_policy: dict[str, JsonValue]
    fee_policy_version: str
    risk_policy_version: str
    simulation_policy_version: str
    confirmation_set_id: str
    minimum_effective_samples: int
    config_hash: Sha256
    revision: int
    created_at: AwareDatetime
    frozen_at: AwareDatetime | None
    evaluated_at: AwareDatetime | None


class StrategyVersionPage(Contract):
    strategy_versions: list[StrategyVersionView]


class ExperimentInput(Contract):
    strategy_version_id: str = Field(min_length=1, max_length=32)
    kind: Literal["FOUR_WAY_ABLATION"] = "FOUR_WAY_ABLATION"


class AblationMetric(Contract):
    sample_count: int
    mean_net_return: str | None
    median_net_return: str | None
    positive_rate: float | None
    mean_delta_vs_formula: str | None
    confidence95_lower: str | None
    confidence95_upper: str | None


class AblationResult(Contract):
    schema_version: Literal["four-way-ablation.v1"] = "four-way-ablation.v1"
    evaluation_status: Literal["VALID", "INSUFFICIENT"]
    dataset: DatasetReference
    confirmation_set_id: str
    minimum_effective_samples: int
    effective_samples: int
    excluded_samples: int
    exclusion_reasons: dict[str, int]
    comparator_policy: dict[str, str]
    variants: dict[
        Literal["JOINT", "NO_AGENT", "NO_QUANT", "FORMULA"],
        AblationMetric,
    ]


class ExperimentView(Contract):
    id: str
    strategy_version_id: str
    kind: Literal["FOUR_WAY_ABLATION"]
    status: Literal["SUCCEEDED", "FAILED"]
    config_hash: Sha256
    confirmation_set_id: str
    sample_count: int
    result: AblationResult
    failure_code: str | None
    created_at: AwareDatetime
    finished_at: AwareDatetime


class ExperimentPage(Contract):
    experiments: list[ExperimentView]


class ReleaseCandidateInput(Contract):
    candidate_id: Identifier
    strategy_version_id: str = Field(min_length=1, max_length=32)
    experiment_id: str = Field(min_length=1, max_length=32)
    deployment_mode: Literal["SHADOW"] = "SHADOW"
    reason: str = Field(min_length=1, max_length=500, pattern=r"\S")


class ReleaseActivationInput(Contract):
    candidate_id: Identifier
    expected_active_release_id: Identifier | None = None
    reason: str = Field(min_length=1, max_length=500, pattern=r"\S")


class ReleaseRollbackInput(Contract):
    expected_active_release_id: Identifier
    reason: str = Field(min_length=1, max_length=500, pattern=r"\S")


class ReleaseView(Contract):
    id: str
    bundle_id: str
    operation: Literal["CANDIDATE", "ACTIVATE", "ROLLBACK"]
    status: Literal["APPROVED", "REJECTED", "ACTIVE", "RETIRED"]
    deployment_mode: Literal["SHADOW"]
    manifest_sha256: Sha256
    source_candidate_bundle_id: str | None
    previous_bundle_id: str | None
    rollback_target_bundle_id: str | None
    strategy_version_id: str
    experiment_id: str
    reason: str
    blocker_codes: list[str]
    allows_new_risk: bool
    created_at: AwareDatetime
    activated_at: AwareDatetime | None


class ReleasePage(Contract):
    active_release_id: str | None
    releases: list[ReleaseView]
