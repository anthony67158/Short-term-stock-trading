from decimal import Decimal

import numpy as np
import pytest

from platform_app.modules.experiments.foundation_return_dataset import (
    reference_full_fill_net_return,
)
from platform_app.modules.experiments.probabilistic_baseline_runner import (
    BaselinePartition,
    ProbabilisticBaselineError,
    fee_adjusted_returns,
    historical_baseline_predictions,
    normalized_weights,
    weighted_quantiles,
)


def partition() -> BaselinePartition:
    return BaselinePartition(
        x=np.zeros((4, 2), dtype=np.float32),
        dates=np.array([20200101, 20200101, 20200102, 20200102]),
        boards=np.array([0, 1, 2, 3], dtype=np.int8),
        instruments=np.array([b"a", b"b", b"c", b"d"]),
        target_return=np.array([-0.03, -0.01, 0.02, 0.08], dtype=np.float32),
        direction=np.array([0, 0, 1, 1], dtype=np.int8),
        sample_weight=np.array([1.0, 1.0, 2.0, 6.0]),
    )


def test_fee_adjusted_returns_match_frozen_decimal_policy():
    gross = np.array([-0.12, 0.0, 0.034567, 0.45], dtype=np.float64)
    boards = np.array(["MAIN", "BEIJING", "STAR", "CHINEXT"])
    execution_dates = np.array(
        ["20210104", "20220428", "20220429", "20230825"],
    )
    terminal_dates = np.array(
        ["20210111", "20220429", "20230828", "20230901"],
    )

    actual = fee_adjusted_returns(
        gross,
        boards,
        execution_dates,
        terminal_dates,
    )
    expected = np.array(
        [
            float(
                reference_full_fill_net_return(
                    gross_return=Decimal(str(value)),
                    board=board,
                    execution_date=execution_date,
                    terminal_date=terminal_date,
                )
            )
            for value, board, execution_date, terminal_date in zip(
                gross,
                boards,
                execution_dates,
                terminal_dates,
                strict=True,
            )
        ]
    )

    np.testing.assert_allclose(actual, expected, atol=1e-12, rtol=0)


def test_weighted_quantiles_use_inverse_probability_mass():
    actual = weighted_quantiles(
        np.array([-2.0, -1.0, 1.0, 3.0]),
        (0.1, 0.5, 0.9),
        sample_weight=np.array([1.0, 1.0, 2.0, 6.0]),
    )

    np.testing.assert_array_equal(actual, np.array([-2.0, 3.0, 3.0]))
    np.testing.assert_allclose(
        normalized_weights(np.array([1.0, 3.0])),
        np.array([0.5, 1.5]),
    )


def test_historical_baseline_repeats_frozen_training_distribution():
    predictions = historical_baseline_predictions(
        partition(),
        3,
        quantiles=(0.1, 0.5, 0.9),
    )

    np.testing.assert_array_equal(
        predictions["pWin"],
        np.full(3, 0.8, dtype=np.float32),
    )
    np.testing.assert_array_equal(
        predictions["q50"],
        np.full(3, 0.08, dtype=np.float32),
    )
    assert list(predictions) == ["pWin", "q10", "q50", "q90"]


def test_baseline_primitives_reject_invalid_inputs():
    with pytest.raises(
        ProbabilisticBaselineError,
        match="PROBABILISTIC_BASELINE_PARTITION_INVALID",
    ):
        BaselinePartition(
            x=np.zeros((2, 1)),
            dates=np.array([20200101]),
            boards=np.array([0, 1]),
            instruments=np.array([b"a", b"b"]),
            target_return=np.array([0.0, 0.1]),
            direction=np.array([0, 1]),
            sample_weight=np.array([1.0, 1.0]),
        )
    with pytest.raises(
        ProbabilisticBaselineError,
        match="PROBABILISTIC_BASELINE_WEIGHT_INVALID",
    ):
        normalized_weights(np.array([1.0, 0.0]))
    with pytest.raises(
        ProbabilisticBaselineError,
        match="PROBABILISTIC_BASELINE_LABEL_INPUT_INVALID",
    ):
        fee_adjusted_returns(
            np.array([-1.0]),
            np.array(["MAIN"]),
            np.array(["20200101"]),
            np.array(["20200102"]),
        )
