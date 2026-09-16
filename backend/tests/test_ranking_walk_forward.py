import numpy as np
import pytest

from platform_app.modules.experiments.quant_model_trainer import QuantModelError
from platform_app.modules.experiments.ranking_walk_forward import (
    CALIBRATION_SESSIONS,
    EMBARGO_SESSIONS,
    FOLD_COUNT,
    MINIMUM_TEST_SESSIONS,
    PURGE_SESSIONS,
    _walk_forward_protocol,
    block_bootstrap_interval,
    expanding_walk_forward_splits,
)


def test_walk_forward_protocol_records_relevance_resolution():
    protocol = _walk_forward_protocol(max_iter=120, relevance_levels=100)

    assert protocol["relevanceLevels"] == 100
    assert protocol["labelGainPolicy"] == "linear-v1"
    assert protocol["maxIterations"] == 120
    assert protocol["hyperparameterTrials"] == 1

    with pytest.raises(QuantModelError, match="RANKING_RELEVANCE_LEVELS_INVALID"):
        _walk_forward_protocol(max_iter=120, relevance_levels=1)


def test_walk_forward_has_five_expanding_purged_out_of_sample_folds():
    dates = np.repeat(np.arange(20160000, 20162536), 2)
    unique = np.unique(dates)

    folds = expanding_walk_forward_splits(dates)

    assert len(folds) == FOLD_COUNT
    assert all(
        np.sum((unique >= fold.test_start) & (unique <= fold.test_end))
        >= MINIMUM_TEST_SESSIONS
        for fold in folds
    )
    assert [fold.test_start for fold in folds[1:]] == [
        fold.test_end + 1 for fold in folds[:-1]
    ]
    assert all(
        np.searchsorted(unique, fold.calibration_start)
        - np.searchsorted(unique, fold.train_end)
        == PURGE_SESSIONS + 1
        for fold in folds
    )
    assert all(
        np.searchsorted(unique, fold.test_start)
        - np.searchsorted(unique, fold.calibration_end)
        == EMBARGO_SESSIONS + 1
        for fold in folds
    )
    assert all(
        np.sum(
            (unique >= fold.calibration_start)
            & (unique <= fold.calibration_end)
        )
        == CALIBRATION_SESSIONS
        for fold in folds
    )
    assert all(
        current.train_end < following.train_end
        for current, following in zip(folds, folds[1:])
    )


def test_block_bootstrap_is_deterministic_and_preserves_positive_edge():
    values = np.linspace(0.001, 0.003, 100)

    first = block_bootstrap_interval(values, iterations=200)
    second = block_bootstrap_interval(values, iterations=200)

    assert first == second
    assert first["observedMean"] == pytest.approx(0.002)
    assert first["oneSided95Lower"] > 0
