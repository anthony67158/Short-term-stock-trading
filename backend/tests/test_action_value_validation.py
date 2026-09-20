import numpy as np
import pytest

from platform_app.modules.experiments.action_value_validation import (
    ActionValueValidationError,
    apply_conformal_interval,
    conformal_interval_correction,
    fit_probability_calibrator,
    inner_validation_masks,
    nested_walk_forward_splits,
    weighted_quantile,
)


def test_outer_walk_forward_has_five_disjoint_test_windows_and_two_gaps():
    dates = np.repeat(np.arange(600), 2)
    folds = nested_walk_forward_splits(dates)
    seen = np.zeros(len(dates), dtype=np.int8)

    assert len(folds) == 5
    for fold in folds:
        train, calibration, test = fold.masks(dates)
        assert len(np.unique(dates[test])) >= 63
        assert dates[calibration].min() - dates[train].max() == 6
        assert dates[test].min() - dates[calibration].max() == 6
        seen += test
    assert np.max(seen) == 1
    assert np.all(seen[dates >= folds[0].test_start] == 1)
    assert np.all(seen[dates < folds[0].test_start] == 0)


def test_inner_validation_never_uses_outer_calibration_or_test_dates():
    dates = np.repeat(np.arange(600), 2)
    outer = nested_walk_forward_splits(dates)[2]
    outer_train, outer_calibration, outer_test = outer.masks(dates)

    inner_train, inner_validation = inner_validation_masks(
        dates,
        outer_train,
        minimum_train_sessions=63,
        validation_sessions=42,
    )

    assert np.all(inner_train <= outer_train)
    assert np.all(inner_validation <= outer_train)
    assert not np.any(inner_train & (outer_calibration | outer_test))
    assert not np.any(inner_validation & (outer_calibration | outer_test))
    assert dates[inner_validation].min() - dates[inner_train].max() == 6


def test_weighted_quantile_respects_sample_weight():
    values = np.asarray([0.0, 1.0, 2.0])

    assert weighted_quantile(values, np.asarray([1, 1, 8]), 0.5) == 2
    assert weighted_quantile(values, np.asarray([8, 1, 1]), 0.5) == 0


@pytest.mark.parametrize("method", ("sigmoid", "isotonic"))
def test_probability_calibrators_are_bounded_and_deterministic(method):
    raw = np.linspace(0.02, 0.98, 120)
    labels = (raw + 0.12 * np.sin(np.arange(len(raw))) > 0.57).astype(int)
    weights = np.linspace(0.5, 1.5, len(raw))

    first = fit_probability_calibrator(raw, labels, weights, method=method)
    second = fit_probability_calibrator(raw, labels, weights, method=method)

    np.testing.assert_allclose(first.predict(raw), second.predict(raw))
    assert np.all((first.predict(raw) >= 0) & (first.predict(raw) <= 1))


def test_conformal_interval_is_non_crossing_and_uses_weighted_residuals():
    q10 = np.asarray([-0.03, -0.02, -0.01, 0.0])
    q50 = np.asarray([0.00, 0.01, 0.02, 0.03])
    q90 = np.asarray([0.03, 0.04, 0.05, 0.06])
    actual = np.asarray([-0.05, 0.0, 0.08, 0.04])
    weights = np.asarray([1, 1, 5, 1])

    correction = conformal_interval_correction(
        q10,
        q90,
        actual,
        weights,
        coverage=0.8,
    )
    lower, median, upper = apply_conformal_interval(
        q10,
        q50,
        q90,
        correction,
    )

    assert correction == pytest.approx(0.03)
    assert np.all(lower <= median)
    assert np.all(median <= upper)


def test_validation_rejects_insufficient_date_support():
    with pytest.raises(
        ActionValueValidationError,
        match="ACTION_VALUE_WALK_FORWARD_SUPPORT_INSUFFICIENT",
    ):
        nested_walk_forward_splits(np.arange(200))
