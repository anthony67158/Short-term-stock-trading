from copy import deepcopy
from types import SimpleNamespace

import numpy as np

from platform_app.modules.experiments.action_value_evaluation import (
    ActionValueReleasePolicy,
    apply_action_value_release_gate,
    evaluate_action_value_predictions,
    fit_action_value_calibration,
)


class _StaticCandidate:
    family = "static"
    feature_names = ("row",)

    def __init__(self, predictions):
        self.predictions = predictions

    def predict(self, features):
        indices = np.asarray(features)[:, 0].astype(int)
        return {
            name: values[indices]
            for name, values in self.predictions.items()
        }


def _fixture():
    count = 160
    index = np.arange(count)
    p_any = (index % 3 != 0).astype(np.int8)
    conditional = p_any.astype(bool)
    full = ((index % 2) == 0).astype(np.int8) * p_any
    win = ((index % 4) < 2).astype(np.int8) * p_any
    stop = ((index % 5) == 0).astype(np.int8) * p_any
    fill = np.where(p_any, np.where(full, 1.0, 0.5), 0.0)
    conditional_return = np.where(win, 0.03, -0.01) * p_any
    requested_return = fill * conditional_return
    raw = {
        "pAnyFill": np.where(p_any, 0.72, 0.28),
        "fillFractionGivenFill": np.where(full, 0.85, 0.58),
        "expectedFillFraction": np.where(p_any, 0.65, 0.2),
        "pFullFillGivenFill": np.where(full, 0.7, 0.3),
        "pFullFill": np.where(full, 0.55, 0.15),
        "pWinGivenFill": np.where(win, 0.75, 0.25),
        "stopHazardGivenFill": np.where(stop, 0.7, 0.2),
        "expectedNetReturnGivenFill": conditional_return + 0.002,
        "expectedNetReturnOnRequestedNotional": requested_return + 0.001,
        "hurdleExpectedNetReturnOnRequestedNotional": requested_return + 0.0015,
        "q10GivenFill": conditional_return - 0.008,
        "q50GivenFill": conditional_return + 0.001,
        "q90GivenFill": conditional_return + 0.008,
    }
    data = SimpleNamespace(
        features=index.reshape(-1, 1).astype(np.float32),
        weights=np.ones(count),
        dates=np.repeat(np.arange(20260101, 20260141), 4),
        boards=np.tile(np.arange(4), count // 4),
        p_any_fill=p_any,
        p_full_fill=full,
        p_win_given_fill=win,
        stop_hazard_given_fill=stop,
        fill_fraction=fill,
        conditional_available=conditional,
        conditional_return=conditional_return,
        net_return_on_requested_notional=requested_return,
    )
    return data, _StaticCandidate(raw)


def test_calibration_uses_held_out_rows_and_preserves_non_crossing_quantiles():
    data, candidate = _fixture()
    calibration_mask = data.dates <= 20260120
    calibration = fit_action_value_calibration(
        candidate,
        data,
        calibration_mask,
        method="sigmoid",
        minimum_selected=5,
    )

    predictions = calibration.predict(data.features[~calibration_mask])

    assert calibration.selection_threshold >= 0
    assert set(calibration.probability_calibrators) == {
        "pAnyFill",
        "pFullFillGivenFill",
        "pWinGivenFill",
        "stopHazardGivenFill",
    }
    assert np.all(predictions["q10GivenFill"] <= predictions["q50GivenFill"])
    assert np.all(predictions["q50GivenFill"] <= predictions["q90GivenFill"])
    assert np.all(predictions["pFullFill"] <= predictions["pAnyFill"])


def test_evaluation_reports_probability_distribution_and_selection_confidence():
    data, candidate = _fixture()
    calibration_mask = data.dates <= 20260120
    test_mask = ~calibration_mask
    calibration = fit_action_value_calibration(
        candidate,
        data,
        calibration_mask,
        minimum_selected=5,
    )
    report = evaluate_action_value_predictions(
        data,
        test_mask,
        calibration.predict(data.features[test_mask]),
        calibration=calibration,
        bootstrap_block_sessions=5,
        bootstrap_iterations=100,
    )

    assert report["probabilities"]["pAnyFill"]["rocAuc"] > 0.9
    assert report["probabilities"]["pWinGivenFill"]["averagePrecision"] > 0.9
    assert 0 <= report["interval"]["coverage80"] <= 1
    assert report["selection"]["samples"] > 0
    assert report["selection"]["dailyNetReturnVsNoTrade"][
        "oneSided95Lower"
    ] > 0


def test_release_gate_never_marks_a_development_candidate_ready():
    data, candidate = _fixture()
    calibration_mask = data.dates <= 20260120
    test_mask = ~calibration_mask
    calibration = fit_action_value_calibration(
        candidate,
        data,
        calibration_mask,
        minimum_selected=5,
    )
    report = evaluate_action_value_predictions(
        data,
        test_mask,
        calibration.predict(data.features[test_mask]),
        calibration=calibration,
        bootstrap_block_sessions=5,
        bootstrap_iterations=100,
    )
    policy = ActionValueReleasePolicy(
        minimum_outer_folds=1,
        minimum_test_sessions_per_fold=1,
        minimum_conditional_samples=1,
        minimum_selected_samples=1,
        minimum_p_any_fill_auc=0,
        minimum_p_full_fill_auc=0,
        minimum_p_win_auc=0,
        minimum_stop_hazard_auc=0,
        maximum_ece=1,
        minimum_brier_skill=-1,
        minimum_log_loss_skill=-1,
        minimum_interval_coverage=0,
        maximum_interval_coverage=1,
        minimum_return_mae_skill=-1,
        minimum_net_return_lower_bound=0,
    )

    passed = apply_action_value_release_gate(
        {"folds": 1, "minimumFoldTestSessions": 20, **report},
        policy,
    )
    assert passed["passed"] is True
    assert passed["candidateStatus"] == "DEVELOPMENT_GATE_PASSED"
    assert passed["releaseStatus"] == "UNAVAILABLE"

    failed_report = deepcopy(report)
    failed_report["selection"]["dailyNetReturnVsNoTrade"][
        "oneSided95Lower"
    ] = -0.001
    failed = apply_action_value_release_gate(
        {"folds": 1, "minimumFoldTestSessions": 20, **failed_report},
        policy,
    )
    assert failed["passed"] is False
    assert "NET_RETURN_CONFIDENCE_LOWER_BOUND" in failed["failedChecks"]

    unchanged = deepcopy(report)
    unchanged["probabilities"]["pAnyFill"]["brierSkill"] = 0
    unchanged_gate = apply_action_value_release_gate(
        {"folds": 1, "minimumFoldTestSessions": 20, **unchanged},
        ActionValueReleasePolicy(
            **{
                **policy.__dict__,
                "minimum_brier_skill": 0,
            }
        ),
    )
    assert "P_ANY_FILL_BRIER_SKILL" in unchanged_gate["failedChecks"]
