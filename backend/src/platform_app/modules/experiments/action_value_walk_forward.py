"""Nested walk-forward model selection for fee-after action value candidates."""

from collections import Counter, defaultdict
from dataclasses import dataclass

import numpy as np
from sklearn.metrics import mean_absolute_error

from platform_app.modules.experiments.action_value_evaluation import (
    PROBABILITY_TARGETS,
    ActionValueCalibration,
    ActionValueReleasePolicy,
    apply_action_value_release_gate,
    evaluate_action_value_predictions,
    fit_action_value_calibration,
)
from platform_app.modules.experiments.action_value_models import (
    ACTION_VALUE_FAMILIES,
    ActionValueCandidate,
    fit_action_value_candidate,
)
from platform_app.modules.experiments.action_value_training import (
    ActionValueTrainingData,
)
from platform_app.modules.experiments.action_value_validation import (
    ActionValueFold,
    inner_validation_masks,
    nested_walk_forward_splits,
    weighted_quantile,
)
from platform_app.modules.experiments.ranking_walk_forward import (
    block_bootstrap_interval,
)

SCHEMA_VERSION = "action-value-walk-forward.v1"


class ActionValueWalkForwardError(ValueError):
    pass


@dataclass(frozen=True)
class ActionValueWalkForwardConfig:
    fold_count: int = 5
    minimum_train_sessions: int = 126
    calibration_sessions: int = 63
    minimum_test_sessions: int = 63
    purge_sessions: int = 5
    embargo_sessions: int = 5
    inner_minimum_train_sessions: int = 63
    inner_validation_sessions: int = 42
    candidate_families: tuple[str, ...] = ACTION_VALUE_FAMILIES
    iterations: int = 120
    min_samples_leaf: int = 100
    threads: int = 2
    calibration_method: str = "sigmoid"
    interval_coverage: float = 0.8
    stress_cost: float = 0.001
    minimum_calibration_selections: int = 30
    bootstrap_block_sessions: int = 10
    bootstrap_iterations: int = 2000


@dataclass(frozen=True)
class ActionValueFoldArtifact:
    fold: ActionValueFold
    candidate: ActionValueCandidate
    calibration: ActionValueCalibration


@dataclass(frozen=True)
class ActionValueWalkForwardResult:
    report: dict
    artifacts: tuple[ActionValueFoldArtifact, ...]


@dataclass(frozen=True)
class WalkForwardActionValuePredictor:
    artifacts: tuple[ActionValueFoldArtifact, ...]

    def predict_action_value(
        self,
        *,
        decision_date,
        scenario_values,
        board=None,
    ) -> dict:
        del board
        date = int(decision_date)
        matches = [
            artifact
            for artifact in self.artifacts
            if artifact.fold.test_start <= date <= artifact.fold.test_end
        ]
        if len(matches) != 1:
            raise ActionValueWalkForwardError("ACTION_VALUE_DATE_OUT_OF_SCOPE")
        artifact = matches[0]
        predictions = artifact.calibration.predict(
            np.asarray([scenario_values], dtype=np.float32)
        )
        return {
            **{name: float(values[0]) for name, values in predictions.items()},
            "selectionThreshold": artifact.calibration.selection_threshold,
            "dailySelectionLimit": artifact.calibration.daily_selection_limit,
            "family": artifact.candidate.family,
            "fold": artifact.fold.fold,
            "releaseStatus": "UNAVAILABLE",
        }


def _candidate_selection_loss(data, mask, predictions):
    weights = data.weights[mask]
    conditional = data.conditional_available[mask]
    losses = []
    for name, (attribute, conditional_only) in PROBABILITY_TARGETS.items():
        local = conditional if conditional_only else np.ones(len(weights), dtype=bool)
        target = np.asarray(getattr(data, attribute)[mask])[local]
        losses.append(
            float(
                np.average(
                    (target - predictions[name][local]) ** 2,
                    weights=weights[local],
                )
            )
        )
    actual = data.net_return_on_requested_notional[mask]
    predicted = predictions["expectedNetReturnOnRequestedNotional"]
    mae = float(mean_absolute_error(actual, predicted, sample_weight=weights))
    baseline = weighted_quantile(actual, weights, 0.5)
    scale = float(
        mean_absolute_error(
            actual,
            np.full(len(actual), baseline),
            sample_weight=weights,
        )
    )
    losses.append(mae / max(scale, 1e-8))
    return float(np.mean(losses))


def _weighted_fold_metric(folds, section, metric, weight):
    values = [
        (fold["evaluation"][section][metric], fold["evaluation"][weight])
        for fold in folds
        if fold["evaluation"][section][metric] is not None
    ]
    if not values:
        return None
    return float(
        np.average(
            [value for value, _sample_count in values],
            weights=[sample_count for _value, sample_count in values],
        )
    )


def _aggregate_probability_metrics(folds):
    output = {}
    for name in PROBABILITY_TARGETS:
        metrics = [fold["evaluation"]["probabilities"][name] for fold in folds]
        samples = sum(item["samples"] for item in metrics)

        def average(field):
            available = [
                (item[field], item["samples"])
                for item in metrics
                if item[field] is not None
            ]
            if not available:
                return None
            return float(
                np.average(
                    [value for value, _count in available],
                    weights=[count for _value, count in available],
                )
            )

        brier = average("brier")
        baseline_brier = average("baselineBrier")
        current_log_loss = average("logLoss")
        baseline_log_loss = average("baselineLogLoss")
        output[name] = {
            "samples": samples,
            "prevalence": average("prevalence"),
            "rocAuc": average("rocAuc"),
            "averagePrecision": average("averagePrecision"),
            "averagePrecisionSkill": average("averagePrecisionSkill"),
            "brier": brier,
            "baselineBrier": baseline_brier,
            "brierSkill": (
                1 - brier / baseline_brier
                if baseline_brier is not None and baseline_brier > 0
                else None
            ),
            "logLoss": current_log_loss,
            "baselineLogLoss": baseline_log_loss,
            "logLossSkill": (
                1 - current_log_loss / baseline_log_loss
                if baseline_log_loss is not None and baseline_log_loss > 0
                else None
            ),
            "ece": average("ece"),
        }
    return output


def _aggregate_fold_reports(folds, config):
    test_samples = sum(fold["evaluation"]["testSamples"] for fold in folds)
    conditional_samples = sum(
        fold["evaluation"]["conditionalSamples"] for fold in folds
    )
    return_mae = _weighted_fold_metric(folds, "return", "mae", "testSamples")
    baseline_mae = _weighted_fold_metric(
        folds,
        "return",
        "baselineMae",
        "testSamples",
    )
    interval_coverage = _weighted_fold_metric(
        folds,
        "interval",
        "coverage80",
        "conditionalSamples",
    )
    interval_width = _weighted_fold_metric(
        folds,
        "interval",
        "meanWidth",
        "conditionalSamples",
    )
    interval_score = _weighted_fold_metric(
        folds,
        "interval",
        "weightedIntervalScore",
        "conditionalSamples",
    )
    daily = np.concatenate(
        [
            np.asarray(
                fold["evaluation"]["selection"]["dailyNetReturnsAtStress"],
                dtype=np.float64,
            )
            for fold in folds
        ]
    )
    selection_samples = sum(
        fold["evaluation"]["selection"]["samples"] for fold in folds
    )
    selected_returns = [
        (
            fold["evaluation"]["selection"]["meanNetReturnAtStress"],
            fold["evaluation"]["selection"]["samples"],
        )
        for fold in folds
        if fold["evaluation"]["selection"]["meanNetReturnAtStress"] is not None
    ]
    support = defaultdict(lambda: {"samples": 0, "conditionalSamples": 0, "selectedSamples": 0})
    domain_daily = defaultdict(list)
    for fold in folds:
        for board, values in fold["evaluation"]["supportByBoard"].items():
            for field in support[board]:
                support[board][field] += values[field]
            domain_daily[board].extend(values["dailyNetReturnsAtStress"])
    fold_returns = [
        fold["evaluation"]["selection"]["dailyNetReturnVsNoTrade"]["observedMean"]
        for fold in folds
    ]
    return {
        "folds": len(folds),
        "minimumFoldTestSessions": min(
            fold["evaluation"]["testSessions"] for fold in folds
        ),
        "testSamples": test_samples,
        "testSessions": sum(
            fold["evaluation"]["testSessions"] for fold in folds
        ),
        "conditionalSamples": conditional_samples,
        "probabilities": _aggregate_probability_metrics(folds),
        "return": {
            "mae": return_mae,
            "baselineMae": baseline_mae,
            "maeSkill": (
                1 - return_mae / baseline_mae
                if baseline_mae is not None and baseline_mae > 0
                else None
            ),
        },
        "interval": {
            "coverage80": interval_coverage,
            "meanWidth": interval_width,
            "weightedIntervalScore": interval_score,
        },
        "selection": {
            "samples": selection_samples,
            "sessions": sum(
                fold["evaluation"]["selection"]["sessions"] for fold in folds
            ),
            "sampleCoverage": selection_samples / test_samples,
            "meanNetReturnAtStress": (
                float(
                    np.average(
                        [value for value, _count in selected_returns],
                        weights=[count for _value, count in selected_returns],
                    )
                )
                if selected_returns
                else None
            ),
            "dailyNetReturnVsNoTrade": block_bootstrap_interval(
                daily,
                block_sessions=config.bootstrap_block_sessions,
                iterations=config.bootstrap_iterations,
            ),
        },
        "supportByBoard": {
            board: {
                **values,
                "dailyNetReturnVsNoTrade": (
                    block_bootstrap_interval(
                        np.asarray(domain_daily[board], dtype=np.float64),
                        block_sessions=config.bootstrap_block_sessions,
                        iterations=config.bootstrap_iterations,
                    )
                    if len(domain_daily[board]) >= config.bootstrap_block_sessions
                    else None
                ),
            }
            for board, values in sorted(support.items())
        },
        "stability": {
            "meanFoldDailyNetReturn": float(np.mean(fold_returns)),
            "medianFoldDailyNetReturn": float(np.median(fold_returns)),
            "worstFoldDailyNetReturn": float(np.min(fold_returns)),
            "foldStandardDeviation": float(np.std(fold_returns)),
            "selectedFamilyCounts": dict(
                sorted(Counter(fold["selectedFamily"] for fold in folds).items())
            ),
        },
    }


def run_action_value_walk_forward(
    data: ActionValueTrainingData,
    *,
    config: ActionValueWalkForwardConfig | None = None,
    release_policy: ActionValueReleasePolicy | None = None,
) -> ActionValueWalkForwardResult:
    config = config or ActionValueWalkForwardConfig()
    release_policy = release_policy or ActionValueReleasePolicy()
    if (
        not config.candidate_families
        or any(name not in ACTION_VALUE_FAMILIES for name in config.candidate_families)
    ):
        raise ActionValueWalkForwardError("ACTION_VALUE_CANDIDATE_FAMILIES_INVALID")
    folds = nested_walk_forward_splits(
        data.dates,
        fold_count=config.fold_count,
        minimum_train_sessions=config.minimum_train_sessions,
        calibration_sessions=config.calibration_sessions,
        minimum_test_sessions=config.minimum_test_sessions,
        purge_sessions=config.purge_sessions,
        embargo_sessions=config.embargo_sessions,
    )
    fold_reports = []
    artifacts = []
    for fold in folds:
        outer_train, calibration_mask, test_mask = fold.masks(data.dates)
        inner_train, inner_validation = inner_validation_masks(
            data.dates,
            outer_train,
            minimum_train_sessions=config.inner_minimum_train_sessions,
            validation_sessions=config.inner_validation_sessions,
            purge_sessions=config.purge_sessions,
        )
        trials = []
        candidates = {}
        for family in config.candidate_families:
            candidate = fit_action_value_candidate(
                data,
                inner_train,
                family=family,
                iterations=config.iterations,
                min_samples_leaf=config.min_samples_leaf,
                threads=config.threads,
            )
            loss = _candidate_selection_loss(
                data,
                inner_validation,
                candidate.predict(data.features[inner_validation]),
            )
            candidates[family] = candidate
            trials.append({"family": family, "selectionLoss": loss})
        selected_family = min(
            config.candidate_families,
            key=lambda family: (
                next(
                    trial["selectionLoss"]
                    for trial in trials
                    if trial["family"] == family
                ),
                config.candidate_families.index(family),
            ),
        )
        candidate = fit_action_value_candidate(
            data,
            outer_train,
            family=selected_family,
            iterations=config.iterations,
            min_samples_leaf=config.min_samples_leaf,
            threads=config.threads,
        )
        calibration = fit_action_value_calibration(
            candidate,
            data,
            calibration_mask,
            method=config.calibration_method,
            interval_coverage=config.interval_coverage,
            stress_cost=config.stress_cost,
            minimum_selected=config.minimum_calibration_selections,
        )
        evaluation = evaluate_action_value_predictions(
            data,
            test_mask,
            calibration.predict(data.features[test_mask]),
            calibration=calibration,
            bootstrap_block_sessions=config.bootstrap_block_sessions,
            bootstrap_iterations=config.bootstrap_iterations,
        )
        fold_reports.append(
            {
                "fold": fold.fold,
                "split": fold.as_dict(),
                "selectedFamily": selected_family,
                "innerTrials": trials,
                "calibration": {
                    "method": config.calibration_method,
                    "selectionThreshold": calibration.selection_threshold,
                    "dailySelectionLimit": calibration.daily_selection_limit,
                    "conformalCorrection": calibration.conformal_correction,
                },
                "evaluation": evaluation,
            }
        )
        artifacts.append(
            ActionValueFoldArtifact(
                fold=fold,
                candidate=candidate,
                calibration=calibration,
            )
        )
    aggregate = _aggregate_fold_reports(fold_reports, config)
    gate = apply_action_value_release_gate(aggregate, release_policy)
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "protocol": {
            **config.__dict__,
            "candidate_families": list(config.candidate_families),
            "outerTestUsedForSelection": False,
            "releasePolicyFrozenBeforeEvaluation": True,
        },
        **aggregate,
        "foldReports": fold_reports,
        "gate": gate,
    }
    return ActionValueWalkForwardResult(
        report=report,
        artifacts=tuple(artifacts),
    )
