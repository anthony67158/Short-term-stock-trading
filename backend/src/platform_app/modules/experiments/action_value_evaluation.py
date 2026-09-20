"""Rolling calibration, metrics, and fail-closed development gates."""

from dataclasses import dataclass, replace

import numpy as np
from sklearn.metrics import (
    average_precision_score,
    log_loss,
    mean_absolute_error,
    roc_auc_score,
)

from platform_app.modules.experiments.action_value_validation import (
    ProbabilityCalibrator,
    apply_conformal_interval,
    conformal_interval_correction,
    fit_probability_calibrator,
    weighted_quantile,
)
from platform_app.modules.experiments.ranking_walk_forward import (
    block_bootstrap_interval,
)

PROBABILITY_TARGETS = {
    "pAnyFill": ("p_any_fill", False),
    "pFullFillGivenFill": ("p_full_fill", True),
    "pWinGivenFill": ("p_win_given_fill", True),
    "stopHazardGivenFill": ("stop_hazard_given_fill", True),
}
DAILY_SELECTION_LIMITS = (1, 3, 5, 10)


class ActionValueEvaluationError(ValueError):
    pass


@dataclass(frozen=True)
class ActionValueCalibration:
    candidate: object
    probability_calibrators: dict[str, ProbabilityCalibrator]
    probability_baselines: dict[str, float]
    conditional_return_offset: float
    requested_return_offset: float
    requested_return_baseline: float
    quantile_location_offset: float
    conformal_correction: float
    selection_threshold: float
    daily_selection_limit: int
    stress_cost: float

    def predict(self, features) -> dict[str, np.ndarray]:
        predictions = self.candidate.predict(features)
        for name, calibrator in self.probability_calibrators.items():
            predictions[name] = calibrator.predict(predictions[name])
        predictions["expectedFillFraction"] = (
            predictions["pAnyFill"] * predictions["fillFractionGivenFill"]
        )
        predictions["pFullFill"] = (
            predictions["pAnyFill"] * predictions["pFullFillGivenFill"]
        )
        predictions["expectedNetReturnGivenFill"] = (
            predictions["expectedNetReturnGivenFill"]
            + self.conditional_return_offset
        )
        predictions["expectedNetReturnOnRequestedNotional"] = (
            predictions["expectedNetReturnOnRequestedNotional"]
            + self.requested_return_offset
        )
        predictions["hurdleExpectedNetReturnOnRequestedNotional"] = (
            predictions["pAnyFill"]
            * predictions["fillFractionGivenFill"]
            * predictions["expectedNetReturnGivenFill"]
        )
        q10, q50, q90 = apply_conformal_interval(
            predictions["q10GivenFill"] + self.quantile_location_offset,
            predictions["q50GivenFill"] + self.quantile_location_offset,
            predictions["q90GivenFill"] + self.quantile_location_offset,
            self.conformal_correction,
        )
        predictions.update(
            {
                "q10GivenFill": q10,
                "q50GivenFill": q50,
                "q90GivenFill": q90,
            }
        )
        return predictions


def _weighted_median(values, weights):
    return weighted_quantile(values, weights, 0.5)


def _daily_top_k_mask(dates, utility, *, limit: int, threshold: float) -> np.ndarray:
    dates = np.asarray(dates)
    utility = np.asarray(utility, dtype=np.float64)
    if (
        dates.shape != utility.shape
        or dates.ndim != 1
        or limit <= 0
        or not np.isfinite(threshold)
        or not np.all(np.isfinite(utility))
    ):
        raise ActionValueEvaluationError("ACTION_VALUE_SELECTION_POLICY_INVALID")
    selected = np.zeros(len(utility), dtype=bool)
    for date in np.unique(dates):
        eligible = np.flatnonzero((dates == date) & (utility > threshold))
        order = np.argsort(-utility[eligible], kind="stable")[:limit]
        selected[eligible[order]] = True
    return selected


def _mean_daily_utility(actual, weights, dates, selected) -> float:
    daily = []
    for date in np.unique(dates):
        local = (dates == date) & selected
        daily.append(
            float(np.average(actual[local], weights=weights[local]))
            if np.any(local)
            else 0.0
        )
    return float(np.mean(daily))


def fit_action_value_calibration(
    candidate,
    data,
    calibration_mask,
    *,
    method: str = "sigmoid",
    interval_coverage: float = 0.8,
    stress_cost: float = 0.001,
    minimum_selected: int = 30,
) -> ActionValueCalibration:
    calibration = np.asarray(calibration_mask, dtype=bool)
    if (
        calibration.shape != (len(data.features),)
        or not np.any(calibration)
        or not 0 < interval_coverage < 1
        or stress_cost < 0
        or minimum_selected <= 0
    ):
        raise ActionValueEvaluationError("ACTION_VALUE_CALIBRATION_CONFIG_INVALID")
    raw = candidate.predict(data.features[calibration])
    conditional = data.conditional_available[calibration]
    weights = data.weights[calibration]
    calibrators = {}
    baselines = {}
    for name, (attribute, conditional_only) in PROBABILITY_TARGETS.items():
        local = conditional if conditional_only else np.ones(len(weights), dtype=bool)
        target = np.asarray(getattr(data, attribute)[calibration])[local]
        calibrators[name] = fit_probability_calibrator(
            raw[name][local],
            target,
            weights[local],
            method=method,
        )
        baselines[name] = float(np.average(target, weights=weights[local]))

    conditional_weights = weights[conditional]
    conditional_actual = data.conditional_return[calibration][conditional]
    conditional_offset = float(
        np.average(
            conditional_actual - raw["expectedNetReturnGivenFill"][conditional],
            weights=conditional_weights,
        )
    )
    requested_actual = data.net_return_on_requested_notional[calibration]
    requested_offset = float(
        np.average(
            requested_actual - raw["expectedNetReturnOnRequestedNotional"],
            weights=weights,
        )
    )
    quantile_location_offset = _weighted_median(
        conditional_actual - raw["q50GivenFill"][conditional],
        conditional_weights,
    )
    conformal_correction = conformal_interval_correction(
        raw["q10GivenFill"][conditional] + quantile_location_offset,
        raw["q90GivenFill"][conditional] + quantile_location_offset,
        conditional_actual,
        conditional_weights,
        coverage=interval_coverage,
    )
    fitted = ActionValueCalibration(
        candidate=candidate,
        probability_calibrators=calibrators,
        probability_baselines=baselines,
        conditional_return_offset=conditional_offset,
        requested_return_offset=requested_offset,
        requested_return_baseline=_weighted_median(requested_actual, weights),
        quantile_location_offset=quantile_location_offset,
        conformal_correction=conformal_correction,
        selection_threshold=0.0,
        daily_selection_limit=DAILY_SELECTION_LIMITS[0],
        stress_cost=stress_cost,
    )
    calibrated = fitted.predict(data.features[calibration])
    predicted_utility = (
        calibrated["hurdleExpectedNetReturnOnRequestedNotional"]
        - stress_cost * calibrated["expectedFillFraction"]
    )
    actual_utility = requested_actual - stress_cost * data.fill_fraction[calibration]
    calibration_dates = data.dates[calibration]
    best_limit = DAILY_SELECTION_LIMITS[0]
    best_score = float("-inf")
    for limit in DAILY_SELECTION_LIMITS:
        selected = _daily_top_k_mask(
            calibration_dates,
            predicted_utility,
            limit=limit,
            threshold=0.0,
        )
        if selected.sum() < minimum_selected:
            continue
        score = _mean_daily_utility(
            actual_utility,
            weights,
            calibration_dates,
            selected,
        )
        if score > best_score:
            best_score = score
            best_limit = limit
    if not np.isfinite(best_score):
        raise ActionValueEvaluationError("ACTION_VALUE_SELECTION_SUPPORT_INSUFFICIENT")
    return replace(fitted, daily_selection_limit=best_limit)


def _expected_calibration_error(labels, probabilities, weights, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    assignments = np.minimum(np.digitize(probabilities, edges[1:-1]), bins - 1)
    total = float(np.sum(weights))
    error = 0.0
    for index in range(bins):
        mask = assignments == index
        if not np.any(mask):
            continue
        observed = float(np.average(labels[mask], weights=weights[mask]))
        predicted = float(np.average(probabilities[mask], weights=weights[mask]))
        error += float(weights[mask].sum()) / total * abs(observed - predicted)
    return error


def _probability_metrics(labels, probabilities, weights, baseline):
    labels = np.asarray(labels, dtype=np.int8)
    probabilities = np.clip(np.asarray(probabilities, dtype=np.float64), 1e-6, 1 - 1e-6)
    weights = np.asarray(weights, dtype=np.float64)
    brier = float(np.average((labels - probabilities) ** 2, weights=weights))
    baseline_probability = np.full(len(labels), baseline)
    baseline_brier = float(
        np.average((labels - baseline_probability) ** 2, weights=weights)
    )
    current_log_loss = float(
        log_loss(labels, probabilities, labels=[0, 1], sample_weight=weights)
    )
    baseline_log_loss = float(
        log_loss(labels, baseline_probability, labels=[0, 1], sample_weight=weights)
    )
    return {
        "samples": int(len(labels)),
        "prevalence": float(np.average(labels, weights=weights)),
        "rocAuc": (
            float(roc_auc_score(labels, probabilities, sample_weight=weights))
            if len(np.unique(labels)) == 2
            else None
        ),
        "averagePrecision": (
            float(average_precision_score(labels, probabilities, sample_weight=weights))
            if len(np.unique(labels)) == 2
            else None
        ),
        "averagePrecisionSkill": (
            float(average_precision_score(labels, probabilities, sample_weight=weights))
            - float(np.average(labels, weights=weights))
            if len(np.unique(labels)) == 2
            else None
        ),
        "brier": brier,
        "baselineBrier": baseline_brier,
        "brierSkill": 1 - brier / baseline_brier if baseline_brier > 0 else None,
        "logLoss": current_log_loss,
        "baselineLogLoss": baseline_log_loss,
        "logLossSkill": (
            1 - current_log_loss / baseline_log_loss
            if baseline_log_loss > 0
            else None
        ),
        "ece": _expected_calibration_error(labels, probabilities, weights),
    }


def evaluate_action_value_predictions(
    data,
    test_mask,
    predictions,
    *,
    calibration: ActionValueCalibration,
    bootstrap_block_sessions: int = 10,
    bootstrap_iterations: int = 2000,
) -> dict:
    test = np.asarray(test_mask, dtype=bool)
    sample_count = int(test.sum())
    if test.shape != (len(data.features),) or not sample_count:
        raise ActionValueEvaluationError("ACTION_VALUE_TEST_MASK_INVALID")
    if any(
        np.asarray(values).shape != (sample_count,)
        or not np.all(np.isfinite(values))
        for values in predictions.values()
    ):
        raise ActionValueEvaluationError("ACTION_VALUE_TEST_PREDICTION_INVALID")
    weights = data.weights[test]
    conditional = data.conditional_available[test]
    probability_metrics = {}
    for name, (attribute, conditional_only) in PROBABILITY_TARGETS.items():
        local = conditional if conditional_only else np.ones(sample_count, dtype=bool)
        probability_metrics[name] = _probability_metrics(
            np.asarray(getattr(data, attribute)[test])[local],
            predictions[name][local],
            weights[local],
            calibration.probability_baselines[name],
        )

    requested_actual = data.net_return_on_requested_notional[test]
    requested_predicted = predictions["expectedNetReturnOnRequestedNotional"]
    mae = float(mean_absolute_error(requested_actual, requested_predicted, sample_weight=weights))
    baseline_mae = float(
        mean_absolute_error(
            requested_actual,
            np.full(sample_count, calibration.requested_return_baseline),
            sample_weight=weights,
        )
    )
    conditional_actual = data.conditional_return[test][conditional]
    conditional_weights = weights[conditional]
    q10 = predictions["q10GivenFill"][conditional]
    q90 = predictions["q90GivenFill"][conditional]
    covered = (conditional_actual >= q10) & (conditional_actual <= q90)
    alpha = 0.2
    interval_score = (
        q90
        - q10
        + 2 / alpha * (q10 - conditional_actual) * (conditional_actual < q10)
        + 2 / alpha * (conditional_actual - q90) * (conditional_actual > q90)
    )

    predicted_utility = (
        predictions["hurdleExpectedNetReturnOnRequestedNotional"]
        - calibration.stress_cost * predictions["expectedFillFraction"]
    )
    actual_utility = (
        requested_actual
        - calibration.stress_cost * data.fill_fraction[test]
    )
    test_dates = data.dates[test]
    selected = _daily_top_k_mask(
        test_dates,
        predicted_utility,
        limit=calibration.daily_selection_limit,
        threshold=calibration.selection_threshold,
    )
    daily = []
    selected_per_session = []
    for date in np.unique(test_dates):
        local = (test_dates == date) & selected
        selected_per_session.append(int(local.sum()))
        daily.append(
            float(np.average(actual_utility[local], weights=weights[local]))
            if np.any(local)
            else 0.0
        )
    confidence = block_bootstrap_interval(
        np.asarray(daily),
        block_sessions=bootstrap_block_sessions,
        iterations=bootstrap_iterations,
    )
    support_by_board = {}
    test_boards = data.boards[test]
    for board in np.unique(test_boards):
        board_mask = test_boards == board
        board_daily = []
        for date in np.unique(test_dates[board_mask]):
            local = board_mask & (test_dates == date) & selected
            board_daily.append(
                float(np.average(actual_utility[local], weights=weights[local]))
                if np.any(local)
                else 0.0
            )
        support_by_board[str(board)] = {
            "samples": int(np.sum(board_mask)),
            "conditionalSamples": int(np.sum(board_mask & conditional)),
            "selectedSamples": int(np.sum(board_mask & selected)),
            "dailyNetReturnsAtStress": board_daily,
        }
    return {
        "testSamples": sample_count,
        "testSessions": int(len(np.unique(test_dates))),
        "conditionalSamples": int(conditional.sum()),
        "probabilities": probability_metrics,
        "return": {
            "mae": mae,
            "baselineMae": baseline_mae,
            "maeSkill": 1 - mae / baseline_mae if baseline_mae > 0 else None,
        },
        "interval": {
            "coverage80": float(np.average(covered, weights=conditional_weights)),
            "meanWidth": float(np.average(q90 - q10, weights=conditional_weights)),
            "weightedIntervalScore": float(
                np.average(interval_score, weights=conditional_weights)
            ),
        },
        "selection": {
            "threshold": calibration.selection_threshold,
            "dailyLimit": calibration.daily_selection_limit,
            "utilitySource": "hurdleExpectedNetReturnOnRequestedNotional",
            "maximumSelectedPerSession": max(selected_per_session, default=0),
            "samples": int(selected.sum()),
            "sessions": int(len(np.unique(test_dates[selected]))),
            "sampleCoverage": float(np.average(selected, weights=weights)),
            "meanNetReturnAtStress": (
                float(np.average(actual_utility[selected], weights=weights[selected]))
                if np.any(selected)
                else None
            ),
            "dailyNetReturnVsNoTrade": confidence,
            "dailyNetReturnsAtStress": daily,
        },
        "supportByBoard": support_by_board,
    }


@dataclass(frozen=True)
class ActionValueReleasePolicy:
    minimum_outer_folds: int = 5
    minimum_test_sessions_per_fold: int = 63
    minimum_conditional_samples: int = 500
    minimum_selected_samples: int = 100
    minimum_p_any_fill_auc: float = 0.5741
    minimum_p_full_fill_auc: float = 0.7757
    minimum_p_win_auc: float = 0.5420
    minimum_stop_hazard_auc: float = 0.5987
    maximum_ece: float = 0.03
    minimum_brier_skill: float = 0.0
    minimum_average_precision_skill: float = 0.0
    minimum_log_loss_skill: float = 0.0
    minimum_interval_coverage: float = 0.78
    maximum_interval_coverage: float = 0.82
    minimum_return_mae_skill: float = 0.0
    minimum_net_return_lower_bound: float = 0.0


def apply_action_value_release_gate(report: dict, policy: ActionValueReleasePolicy) -> dict:
    probabilities = report["probabilities"]

    def at_least(value, minimum):
        return value is not None and value >= minimum

    def greater_than(value, minimum):
        return value is not None and value > minimum

    checks = {
        "OUTER_FOLD_SUPPORT": report["folds"] >= policy.minimum_outer_folds,
        "TEST_SESSION_SUPPORT": (
            report["minimumFoldTestSessions"] >= policy.minimum_test_sessions_per_fold
        ),
        "CONDITIONAL_SAMPLE_SUPPORT": (
            report["conditionalSamples"] >= policy.minimum_conditional_samples
        ),
        "SELECTION_SAMPLE_SUPPORT": (
            report["selection"]["samples"] >= policy.minimum_selected_samples
        ),
        "P_ANY_FILL_AUC": at_least(
            probabilities["pAnyFill"]["rocAuc"],
            policy.minimum_p_any_fill_auc,
        ),
        "P_ANY_FILL_BRIER_SKILL": greater_than(
            probabilities["pAnyFill"]["brierSkill"],
            policy.minimum_brier_skill,
        ),
        "P_ANY_FILL_ECE": (
            probabilities["pAnyFill"]["ece"] <= policy.maximum_ece
        ),
        "P_FULL_FILL_AUC": at_least(
            probabilities["pFullFillGivenFill"]["rocAuc"],
            policy.minimum_p_full_fill_auc,
        ),
        "P_FULL_FILL_BRIER_SKILL": at_least(
            probabilities["pFullFillGivenFill"]["brierSkill"],
            policy.minimum_brier_skill,
        ),
        "P_WIN_AUC": at_least(
            probabilities["pWinGivenFill"]["rocAuc"],
            policy.minimum_p_win_auc,
        ),
        "P_WIN_AVERAGE_PRECISION_SKILL": greater_than(
            probabilities["pWinGivenFill"]["averagePrecisionSkill"],
            policy.minimum_average_precision_skill,
        ),
        "P_WIN_LOG_LOSS_SKILL": greater_than(
            probabilities["pWinGivenFill"]["logLossSkill"],
            policy.minimum_log_loss_skill,
        ),
        "STOP_HAZARD_AUC": at_least(
            probabilities["stopHazardGivenFill"]["rocAuc"],
            policy.minimum_stop_hazard_auc,
        ),
        "INTERVAL_COVERAGE": (
            policy.minimum_interval_coverage
            <= report["interval"]["coverage80"]
            <= policy.maximum_interval_coverage
        ),
        "RETURN_MAE_SKILL": greater_than(
            report["return"]["maeSkill"],
            policy.minimum_return_mae_skill,
        ),
        "NET_RETURN_CONFIDENCE_LOWER_BOUND": (
            report["selection"]["dailyNetReturnVsNoTrade"]["oneSided95Lower"]
            > policy.minimum_net_return_lower_bound
        ),
    }
    failed = [name for name, passed in checks.items() if not passed]
    return {
        "passed": not failed,
        "candidateStatus": "DEVELOPMENT_GATE_PASSED" if not failed else "REJECTED",
        "releaseStatus": "UNAVAILABLE",
        "checks": checks,
        "failedChecks": failed,
    }
