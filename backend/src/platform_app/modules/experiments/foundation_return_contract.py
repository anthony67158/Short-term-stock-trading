"""Immutable contract for the budget-capped return-distribution experiment."""

import hashlib
import json
import os
import re
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, model_validator

from platform_app.contracts.base import Contract, DecimalString
from platform_app.modules.experiments.contracts import Identifier, Sha256

SCHEMA_VERSION = "foundation-return-experiment.v1"
FREEZE_SCHEMA_VERSION = "foundation-return-experiment-freeze.v1"
DEFAULT_SEEDS = (17, 29, 43)
DEFAULT_QUANTILES = (0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95)

DateKey = Annotated[str, Field(pattern=r"^\d{8}$")]
Revision = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^\S+$")]
HttpsUrl = Annotated[str, Field(min_length=9, max_length=500, pattern=r"^https://")]


class FoundationReturnContractError(ValueError):
    pass


class FoundationDatasetContract(Contract):
    dataset_id: Identifier
    database_sha256: Sha256
    feature_schema_sha256: Sha256
    label_policy_sha256: Sha256
    fee_policy_version: Identifier
    execution_policy_version: Identifier
    target: Literal["r_net_5d"] = "r_net_5d"
    history_sessions: int = Field(strict=True, ge=60, le=120)


class FoundationModelSource(Contract):
    role: Literal["PRIMARY", "TEACHER", "BASELINE"]
    model_id: str = Field(min_length=1, max_length=200, pattern=r"^\S+$")
    source_kind: Literal["HUGGING_FACE", "PYPI"]
    source_url: HttpsUrl
    revision: Revision
    license: str = Field(min_length=1, max_length=80, pattern=r"^\S")
    adaptation: Literal["FROZEN_BACKBONE", "LORA", "FROZEN", "FROM_SCRATCH"]

    @model_validator(mode="after")
    def role_matches_adaptation(self):
        allowed = {
            "PRIMARY": {"FROZEN_BACKBONE", "LORA"},
            "TEACHER": {"FROZEN"},
            "BASELINE": {"FROM_SCRATCH"},
        }
        if self.adaptation not in allowed[self.role]:
            raise ValueError("模型角色与适配方式不一致")
        if (
            self.source_kind == "HUGGING_FACE"
            and re.fullmatch(r"[0-9a-f]{40,64}", self.revision) is None
        ):
            raise ValueError("Hugging Face 权重必须锁定不可变 commit revision")
        return self


class FoundationFoldContract(Contract):
    fold: int = Field(strict=True, ge=1, le=5)
    train_end: DateKey
    probability_calibration_start: DateKey
    probability_calibration_end: DateKey
    conformal_calibration_start: DateKey
    conformal_calibration_end: DateKey
    test_start: DateKey
    test_end: DateKey
    purge_sessions: int = Field(strict=True, ge=5, le=252)
    embargo_sessions: int = Field(strict=True, ge=5, le=252)

    @model_validator(mode="after")
    def periods_are_ordered(self):
        if not (
            self.train_end
            < self.probability_calibration_start
            <= self.probability_calibration_end
            < self.conformal_calibration_start
            <= self.conformal_calibration_end
            < self.test_start
            <= self.test_end
        ):
            raise ValueError("训练、校准和测试区间必须按时间顺序且互不重叠")
        return self


class FoundationTrainingProtocol(Contract):
    folds: tuple[FoundationFoldContract, ...] = Field(min_length=5, max_length=5)
    seeds: tuple[int, ...] = Field(default=DEFAULT_SEEDS, min_length=3, max_length=3)
    quantiles: tuple[float, ...] = Field(
        default=DEFAULT_QUANTILES,
        min_length=7,
        max_length=7,
    )
    final_confirmation_fold: Literal[5] = 5
    max_training_windows_per_fold: int = Field(
        default=1_500_000,
        strict=True,
        ge=1,
        le=1_500_000,
    )
    history_sessions: int = Field(default=120, strict=True, ge=60, le=120)
    internal_validation_sessions: int = Field(default=63, strict=True, ge=20, le=252)
    max_epochs: int = Field(default=20, strict=True, ge=1, le=20)
    early_stopping_patience: int = Field(default=3, strict=True, ge=1, le=10)
    effective_batch_size: int = Field(default=256, strict=True, ge=1, le=8192)
    max_trainable_parameters: int = Field(default=5_000_000, strict=True, ge=1)
    max_trainable_fraction: float = Field(default=0.20, gt=0, le=0.20)

    @model_validator(mode="after")
    def protocol_is_frozen(self):
        fold_numbers = tuple(fold.fold for fold in self.folds)
        if fold_numbers != (1, 2, 3, 4, 5):
            raise ValueError("必须按 1 至 5 顺序提供五个 walk-forward 折")
        for previous, current in zip(self.folds, self.folds[1:]):
            if (
                previous.train_end >= current.train_end
                or previous.test_end >= current.test_start
            ):
                raise ValueError("walk-forward 折必须按时间扩展且测试窗口互不重叠")
        if len(set(self.seeds)) != len(self.seeds):
            raise ValueError("随机种子必须互不重复")
        if tuple(sorted(set(self.quantiles))) != self.quantiles:
            raise ValueError("分位数必须严格递增且互不重复")
        if self.quantiles != DEFAULT_QUANTILES:
            raise ValueError("v1 分位网格必须使用预注册值")
        return self


class FoundationBudgetContract(Contract):
    currency: Literal["CNY"] = "CNY"
    total_limit: DecimalString = Field(gt=0, decimal_places=2)
    planned_gpu_limit: DecimalString = Field(ge=0, decimal_places=2)
    persistent_storage_limit: DecimalString = Field(ge=0, decimal_places=2)
    data_transfer_limit: DecimalString = Field(ge=0, decimal_places=2)
    retry_limit: DecimalString = Field(ge=0, decimal_places=2)
    contingency_reserve: DecimalString = Field(ge=0, decimal_places=2)
    hard_stop_spend: DecimalString = Field(gt=0, decimal_places=2)
    provider_unit_price_limit: DecimalString = Field(gt=0, decimal_places=2)
    planned_paid_gpu_hours: DecimalString = Field(gt=0, decimal_places=2)

    @model_validator(mode="after")
    def budget_is_consistent(self):
        allocated = (
            self.planned_gpu_limit
            + self.persistent_storage_limit
            + self.data_transfer_limit
            + self.retry_limit
            + self.contingency_reserve
        )
        if self.total_limit != Decimal("100.00") or allocated != self.total_limit:
            raise ValueError("预算必须精确分配且总额固定为 100 元")
        if self.hard_stop_spend != self.total_limit - self.contingency_reserve:
            raise ValueError("停止线必须保留完整应急金")
        planned_gpu_cost = self.provider_unit_price_limit * self.planned_paid_gpu_hours
        if planned_gpu_cost > self.planned_gpu_limit:
            raise ValueError("计划 GPU 小时超过有效 GPU 预算")
        return self


class FoundationReleasePolicy(Contract):
    default_status: Literal["UNAVAILABLE"] = "UNAVAILABLE"
    allow_production_pointer_update: Literal[False] = False
    require_statistical_gate: Literal[True] = True
    require_execution_gate: Literal[True] = True
    require_capacity_gate: Literal[True] = True
    require_position_gate: Literal[True] = True
    require_agent_gate: Literal[True] = True
    require_independent_forward_gate: Literal[True] = True


class FoundationReturnExperiment(Contract):
    schema_version: Literal["foundation-return-experiment.v1"] = SCHEMA_VERSION
    experiment_key: Identifier
    confirmation_set_id: Identifier
    dataset: FoundationDatasetContract
    models: tuple[FoundationModelSource, ...] = Field(min_length=6, max_length=6)
    training: FoundationTrainingProtocol
    budget: FoundationBudgetContract
    release_policy: FoundationReleasePolicy = Field(
        default_factory=FoundationReleasePolicy,
    )

    @model_validator(mode="after")
    def model_roster_is_complete(self):
        roles = [model.role for model in self.models]
        if roles.count("PRIMARY") != 1:
            raise ValueError("必须且只能配置一个主候选")
        if roles.count("TEACHER") != 2:
            raise ValueError("必须配置两个固定教师")
        if roles.count("BASELINE") != 3:
            raise ValueError("必须配置三个冻结强基线")
        model_ids = [model.model_id for model in self.models]
        if len(set(model_ids)) != len(model_ids):
            raise ValueError("模型标识必须互不重复")
        if self.dataset.history_sessions != self.training.history_sessions:
            raise ValueError("数据与训练历史窗口必须一致")
        return self


def canonical_experiment_json(experiment: FoundationReturnExperiment) -> str:
    return json.dumps(
        experiment.model_dump(mode="json", by_alias=True),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def experiment_config_sha256(experiment: FoundationReturnExperiment) -> str:
    return hashlib.sha256(canonical_experiment_json(experiment).encode()).hexdigest()


def experiment_id(experiment: FoundationReturnExperiment) -> str:
    return f"{experiment.experiment_key}-{experiment_config_sha256(experiment)[:16]}"


def frozen_experiment_payload(experiment: FoundationReturnExperiment) -> dict:
    return {
        "schemaVersion": FREEZE_SCHEMA_VERSION,
        "experimentId": experiment_id(experiment),
        "configHash": experiment_config_sha256(experiment),
        "releaseStatus": "UNAVAILABLE",
        "configuration": experiment.model_dump(mode="json", by_alias=True),
    }


def freeze_experiment(root: Path, experiment: FoundationReturnExperiment) -> dict:
    root = root.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = root / "experiment.json"
    expected = frozen_experiment_payload(experiment)
    if path.exists():
        try:
            existing = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError, TypeError) as exc:
            raise FoundationReturnContractError(
                "FOUNDATION_EXPERIMENT_FREEZE_INVALID",
            ) from exc
        if existing != expected:
            raise FoundationReturnContractError(
                "FOUNDATION_EXPERIMENT_RESUME_MISMATCH",
            )
        return existing
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(expected, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )
    os.replace(temporary, path)
    return expected


def load_frozen_experiment(root: Path) -> FoundationReturnExperiment:
    path = root.expanduser().resolve() / "experiment.json"
    try:
        frozen = json.loads(path.read_text())
        experiment = FoundationReturnExperiment.model_validate(frozen["configuration"])
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise FoundationReturnContractError(
            "FOUNDATION_EXPERIMENT_FREEZE_INVALID",
        ) from exc
    if (
        frozen.get("schemaVersion") != FREEZE_SCHEMA_VERSION
        or frozen.get("releaseStatus") != "UNAVAILABLE"
        or frozen.get("configHash") != experiment_config_sha256(experiment)
        or frozen.get("experimentId") != experiment_id(experiment)
    ):
        raise FoundationReturnContractError(
            "FOUNDATION_EXPERIMENT_FREEZE_INVALID",
        )
    return experiment
