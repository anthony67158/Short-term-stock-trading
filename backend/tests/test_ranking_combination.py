"""Leakage and reproducibility checks for offline model selection."""

import numpy as np
import pytest

from platform_app.modules.experiments.ranking_combination import (
    combination_scores,
    daily_percentiles,
    temporal_fusion_weights,
)
from platform_app.modules.experiments.ranking_window_runner import recent_session_mask
from platform_app.modules.experiments.ranking_walk_forward import expanding_walk_forward_splits


def test_daily_normalization_does_not_observe_future_cross_sections():
    scores = np.array([[1, 8], [3, 2], [6, 4], [-100, 99], [0, 0]], dtype=float)
    dates = np.array([1, 1, 1, 2, 2])
    first = daily_percentiles(dates[:3], scores[:3])
    combined = daily_percentiles(dates, scores)
    np.testing.assert_array_equal(first, combined[:3])
    np.testing.assert_allclose(first[:, 0], [0, 0.5, 1])


@pytest.mark.parametrize("train_end,test_start", [(10, 30), (1, 19), (1, 15)])
def test_fusion_rejects_training_or_test_overlap(train_end, test_start):
    with pytest.raises(ValueError, match="FUSION_WINDOW"):
        temporal_fusion_weights(
            np.zeros((10, 4)), np.zeros(10), np.arange(10, 20),
            model_train_end=train_end, test_start=test_start,
        )


def test_fusion_detects_signal_and_shrinks_weights_without_negative_exposure():
    rng = np.random.default_rng(41)
    predictions = rng.uniform(size=(1000, 4))
    weights = temporal_fusion_weights(
        predictions, predictions[:, 2], np.repeat(np.arange(10, 20), 100),
        model_train_end=1, test_start=30,
    )
    assert np.argmax(weights) == 2
    assert weights[2] == pytest.approx(0.625, abs=1e-4)
    assert weights.min() >= 0.125
    assert weights.sum() == pytest.approx(1)


def test_split_labels_mature_before_fusion_and_test():
    dates = np.arange(1000, 3500)
    for fold in expanding_walk_forward_splits(dates):
        train, fusion, test = fold.masks(dates)
        assert dates[train].max() + 5 < dates[fusion].min()
        assert dates[fusion].max() + 5 < dates[test].min()


def test_combination_scores_supports_explicit_window_candidates():
    predictions = np.array([[0.1, 0.3, 0.8], [0.6, 0.5, 0.4]])
    weights = np.array([0.2, 0.3, 0.5])
    scores = combination_scores(
        predictions,
        weights,
        candidate_names=("long", "short252", "short504"),
    )
    np.testing.assert_allclose(scores["temporal"], predictions @ weights)
    np.testing.assert_allclose(
        scores["equal_without_short252"],
        predictions[:, [0, 2]].mean(axis=1),
    )


def test_recent_session_mask_uses_only_latest_complete_training_sessions():
    dates = np.repeat(np.arange(10, 20), 2)
    train = dates < 18
    selected = recent_session_mask(dates, train, 3)
    np.testing.assert_array_equal(np.unique(dates[selected]), [15, 16, 17])
    with pytest.raises(ValueError, match="WINDOW_SUPPORT"):
        recent_session_mask(dates, train, 9)
