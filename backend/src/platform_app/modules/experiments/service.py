import hashlib
import json
from collections import Counter
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import Contract, utcnow
from platform_app.modules.experiments.contracts import (
    AblationMetric,
    AblationResult,
    ExperimentInput,
    ExperimentPage,
    ExperimentView,
    FreezeStrategyInput,
    StrategyVersionInput,
    StrategyVersionPage,
    StrategyVersionView,
)
from platform_app.modules.experiments.models import Experiment, StrategyVersion
from platform_app.modules.identity.models import User
from platform_app.modules.learning.models import (
    ProspectiveOutcome,
    ProspectiveSample,
)
from platform_app.modules.operations.models import Outbox

VARIANTS = ("JOINT", "NO_AGENT", "NO_QUANT", "FORMULA")
NO_QUANT_ACTIONS = {
    "SUPPORTED": "ADD",
    "WEAKENED": "REDUCE",
    "INVALIDATED": "EXIT",
    "UNCERTAIN": "HOLD",
}


class ExperimentError(ValueError):
    def __init__(self, code: str, message: str, status: int = 409):
        self.code, self.message, self.status = code, message, status


def _fingerprint(value: Contract | dict) -> str:
    payload = (
        value.model_dump(mode="json", exclude_none=True) if isinstance(value, Contract) else value
    )
    return hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def _strategy_view(row: StrategyVersion) -> StrategyVersionView:
    return StrategyVersionView.model_validate(row)


def _experiment_view(row: Experiment) -> ExperimentView:
    return ExperimentView.model_validate(row)


def create_strategy_version(
    owner_id: str,
    body: StrategyVersionInput,
    key: str,
) -> StrategyVersionView:
    request_hash = _fingerprint(body)
    config_hash = request_hash
    with sessions().begin() as db:
        db.scalar(select(User).where(User.id == owner_id).with_for_update())
        existing = db.scalar(
            select(StrategyVersion).where(
                StrategyVersion.owner_id == owner_id,
                StrategyVersion.request_key == key,
            )
        )
        if existing:
            if existing.request_hash != request_hash:
                raise ExperimentError(
                    "IDEMPOTENCY_CONFLICT",
                    "同一请求编号对应不同策略配置",
                )
            return _strategy_view(existing)
        duplicate = db.scalar(
            select(StrategyVersion).where(
                StrategyVersion.owner_id == owner_id,
                StrategyVersion.strategy_key == body.strategy_key,
                StrategyVersion.config_hash == config_hash,
            )
        )
        if duplicate:
            raise ExperimentError(
                "STRATEGY_CONFIG_EXISTS",
                "相同冻结配置已经注册，请直接使用已有版本",
            )
        version = (
            int(
                db.scalar(
                    select(func.coalesce(func.max(StrategyVersion.version), 0)).where(
                        StrategyVersion.owner_id == owner_id,
                        StrategyVersion.strategy_key == body.strategy_key,
                    )
                )
            )
            + 1
        )
        values = body.model_dump(mode="json")
        row = StrategyVersion(
            owner_id=owner_id,
            version=version,
            status="DRAFT",
            config_hash=config_hash,
            request_key=key,
            request_hash=request_hash,
            **values,
        )
        db.add(row)
        db.flush()
        return _strategy_view(row)


def freeze_strategy_version(
    owner_id: str,
    strategy_version_id: str,
    body: FreezeStrategyInput,
) -> StrategyVersionView:
    with sessions().begin() as db:
        row = db.scalar(
            select(StrategyVersion)
            .where(
                StrategyVersion.id == strategy_version_id,
                StrategyVersion.owner_id == owner_id,
            )
            .with_for_update()
        )
        if not row:
            raise ExperimentError(
                "STRATEGY_VERSION_NOT_FOUND",
                "策略版本不存在或无权访问",
                404,
            )
        if row.revision != body.expected_revision:
            raise ExperimentError(
                "STRATEGY_VERSION_CONFLICT",
                "策略版本已有变化，请刷新后核对",
            )
        if row.status == "DRAFT":
            row.status = "FROZEN"
            row.revision += 1
            row.frozen_at = utcnow()
        return _strategy_view(row)


def strategy_version(
    owner_id: str,
    strategy_version_id: str,
) -> StrategyVersionView:
    with sessions()() as db:
        row = db.scalar(
            select(StrategyVersion).where(
                StrategyVersion.id == strategy_version_id,
                StrategyVersion.owner_id == owner_id,
            )
        )
        if not row:
            raise ExperimentError(
                "STRATEGY_VERSION_NOT_FOUND",
                "策略版本不存在或无权访问",
                404,
            )
        return _strategy_view(row)


def strategy_versions(owner_id: str, limit: int) -> StrategyVersionPage:
    with sessions()() as db:
        rows = list(
            db.scalars(
                select(StrategyVersion)
                .where(StrategyVersion.owner_id == owner_id)
                .order_by(
                    StrategyVersion.created_at.desc(),
                    StrategyVersion.id.desc(),
                )
                .limit(limit)
            )
        )
        return StrategyVersionPage(strategy_versions=[_strategy_view(row) for row in rows])


def _action_name(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    return "HOLD" if value in {"NONE", "WAIT"} else value


def _quant_action(sample: ProspectiveSample) -> str | None:
    values = sample.quant_prediction.get("values")
    if not isinstance(values, list):
        return None
    candidates = []
    for index, value in enumerate(values):
        if not isinstance(value, dict):
            continue
        action = _action_name(value.get("action"))
        estimate = value.get(
            "expected_delta_return_vs_hold",
            value.get("expectedDeltaReturnVsHold"),
        )
        if action not in {"HOLD", "ADD", "REDUCE", "EXIT"}:
            continue
        try:
            score = Decimal(str(estimate))
        except (InvalidOperation, TypeError, ValueError):
            continue
        if score.is_finite():
            candidates.append((score, -index, action))
    return max(candidates)[2] if candidates else None


def _sample_actions(sample: ProspectiveSample) -> dict[str, str] | None:
    joint = _action_name(sample.scenario.get("selectedAction"))
    no_agent = _quant_action(sample)
    thesis = sample.agent_features.get("thesisStatus")
    no_quant = NO_QUANT_ACTIONS.get(thesis)
    if joint not in {"HOLD", "ADD", "REDUCE", "EXIT"} or no_agent is None or no_quant is None:
        return None
    return {
        "JOINT": joint,
        "NO_AGENT": no_agent,
        "NO_QUANT": no_quant,
        "FORMULA": "HOLD",
    }


def _outcome_returns(outcome: ProspectiveOutcome) -> dict[str, Decimal] | None:
    raw = outcome.simulation_outcome.get("actionNetReturns")
    if not isinstance(raw, dict):
        return None
    values = {}
    for action in ("HOLD", "ADD", "REDUCE", "EXIT"):
        value = raw.get(action)
        if not isinstance(value, str):
            return None
        try:
            parsed = Decimal(value)
        except InvalidOperation:
            return None
        if not parsed.is_finite():
            return None
        values[action] = parsed
    return values


def _decimal(value: Decimal) -> str:
    rendered = format(value.quantize(Decimal("0.00000001")), "f")
    return "0.00000000" if rendered == "-0.00000000" else rendered


def _metric(values: list[Decimal], formulas: list[Decimal]) -> AblationMetric:
    if not values:
        return AblationMetric(
            sample_count=0,
            mean_net_return=None,
            median_net_return=None,
            positive_rate=None,
            mean_delta_vs_formula=None,
            confidence95_lower=None,
            confidence95_upper=None,
        )
    count = len(values)
    mean = sum(values) / count
    ordered = sorted(values)
    middle = count // 2
    median = ordered[middle] if count % 2 else (ordered[middle - 1] + ordered[middle]) / 2
    if count > 1:
        variance = sum((value - mean) ** 2 for value in values) / (count - 1)
        margin = Decimal("1.96") * (variance / count).sqrt()
    else:
        margin = Decimal(0)
    return AblationMetric(
        sample_count=count,
        mean_net_return=_decimal(mean),
        median_net_return=_decimal(median),
        positive_rate=sum(value > 0 for value in values) / count,
        mean_delta_vs_formula=_decimal(
            sum(value - formula for value, formula in zip(values, formulas, strict=True)) / count
        ),
        confidence95_lower=_decimal(mean - margin),
        confidence95_upper=_decimal(mean + margin),
    )


def evaluate_four_way_ablation(
    rows: list[tuple[ProspectiveSample, ProspectiveOutcome]],
    strategy: StrategyVersion,
) -> AblationResult:
    values: dict[str, list[Decimal]] = {variant: [] for variant in VARIANTS}
    formula_values: list[Decimal] = []
    exclusions = Counter()
    for sample, outcome in rows:
        actions = _sample_actions(sample)
        if actions is None:
            exclusions["INPUT_CONTRACT_INCOMPLETE"] += 1
            continue
        returns = _outcome_returns(outcome)
        if returns is None:
            exclusions["OUTCOME_CONTRACT_INCOMPLETE"] += 1
            continue
        selected = {variant: returns[action] for variant, action in actions.items()}
        formula_values.append(selected["FORMULA"])
        for variant in VARIANTS:
            values[variant].append(selected[variant])
    effective = len(formula_values)
    status = "VALID" if effective >= strategy.minimum_effective_samples else "INSUFFICIENT"
    return AblationResult(
        evaluation_status=status,
        dataset=strategy.dataset,
        confirmation_set_id=strategy.confirmation_set_id,
        minimum_effective_samples=strategy.minimum_effective_samples,
        effective_samples=effective,
        excluded_samples=sum(exclusions.values()),
        exclusion_reasons=dict(sorted(exclusions.items())),
        comparator_policy={
            "JOINT": "PUBLISHED_JOINT_ACTION",
            "NO_AGENT": "MAX_QUANT_EXPECTED_DELTA_RETURN",
            "NO_QUANT": "THESIS_STATUS_ACTION_V1",
            "FORMULA": "HOLD_EXISTING_POSITION_V1",
        },
        variants={variant: _metric(values[variant], formula_values) for variant in VARIANTS},
    )


def create_experiment(
    owner_id: str,
    body: ExperimentInput,
    key: str,
) -> ExperimentView:
    request_hash = _fingerprint(body)
    with sessions().begin() as db:
        existing = db.scalar(
            select(Experiment).where(
                Experiment.owner_id == owner_id,
                Experiment.request_key == key,
            )
        )
        if existing:
            if existing.request_hash != request_hash:
                raise ExperimentError(
                    "IDEMPOTENCY_CONFLICT",
                    "同一请求编号对应不同实验",
                )
            return _experiment_view(existing)
        strategy = db.scalar(
            select(StrategyVersion)
            .where(
                StrategyVersion.id == body.strategy_version_id,
                StrategyVersion.owner_id == owner_id,
            )
            .with_for_update()
        )
        if not strategy:
            raise ExperimentError(
                "STRATEGY_VERSION_NOT_FOUND",
                "策略版本不存在或无权访问",
                404,
            )
        if strategy.status != "FROZEN":
            raise ExperimentError(
                "STRATEGY_VERSION_NOT_FROZEN",
                "只有冻结且尚未评估的策略版本可以运行实验",
            )
        previous = db.scalar(
            select(Experiment).where(Experiment.strategy_version_id == strategy.id)
        )
        if previous:
            raise ExperimentError(
                "STRATEGY_VERSION_ALREADY_EVALUATED",
                "该冻结版本已消费确认集，不能重复调参或重跑",
            )
        dataset_id = strategy.dataset["dataset_id"]
        dataset_sha256 = strategy.dataset["sha256"]
        rows = list(
            db.execute(
                select(ProspectiveSample, ProspectiveOutcome)
                .join(
                    ProspectiveOutcome,
                    ProspectiveOutcome.sample_id == ProspectiveSample.id,
                )
                .where(
                    ProspectiveSample.owner_id == owner_id,
                    ProspectiveSample.status == "MATURED",
                    ProspectiveOutcome.simulation_policy_version
                    == strategy.simulation_policy_version,
                    ProspectiveOutcome.source_dataset_id == dataset_id,
                    ProspectiveOutcome.source_dataset_sha256 == dataset_sha256,
                )
                .order_by(
                    ProspectiveSample.decision_as_of,
                    ProspectiveSample.id,
                )
            )
        )
        result = evaluate_four_way_ablation(rows, strategy)
        succeeded = result.evaluation_status == "VALID"
        now = utcnow()
        experiment = Experiment(
            owner_id=owner_id,
            strategy_version_id=strategy.id,
            kind=body.kind,
            status="SUCCEEDED" if succeeded else "FAILED",
            config_hash=strategy.config_hash,
            request_key=key,
            request_hash=request_hash,
            confirmation_set_id=strategy.confirmation_set_id,
            sample_count=result.effective_samples,
            result=result.model_dump(mode="json"),
            failure_code=(None if succeeded else "MATURED_SAMPLE_SUPPORT_INSUFFICIENT"),
            created_at=now,
            finished_at=now,
        )
        db.add(experiment)
        db.flush()
        strategy.status = "EVALUATED"
        strategy.revision += 1
        strategy.evaluated_at = now
        db.add(
            Outbox(
                owner_id=owner_id,
                event_type="experiment.finished",
                aggregate_id=experiment.id,
                payload={
                    "schemaVersion": "1",
                    "strategyVersionId": strategy.id,
                    "status": experiment.status,
                    "failureCode": experiment.failure_code,
                },
            )
        )
        return _experiment_view(experiment)


def experiment(owner_id: str, experiment_id: str) -> ExperimentView:
    with sessions()() as db:
        row = db.scalar(
            select(Experiment).where(
                Experiment.id == experiment_id,
                Experiment.owner_id == owner_id,
            )
        )
        if not row:
            raise ExperimentError(
                "EXPERIMENT_NOT_FOUND",
                "实验不存在或无权访问",
                404,
            )
        return _experiment_view(row)


def experiments(owner_id: str, limit: int) -> ExperimentPage:
    with sessions()() as db:
        rows = list(
            db.scalars(
                select(Experiment)
                .where(Experiment.owner_id == owner_id)
                .order_by(
                    Experiment.created_at.desc(),
                    Experiment.id.desc(),
                )
                .limit(limit)
            )
        )
        return ExperimentPage(experiments=[_experiment_view(row) for row in rows])
