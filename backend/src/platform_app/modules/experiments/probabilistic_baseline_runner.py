"""Reproducible probabilistic tree baselines on frozen foundation folds."""

from dataclasses import dataclass

import numpy as np

from platform_app.modules.experiments.foundation_return_contract import (
    DEFAULT_QUANTILES,
)

SCHEMA_VERSION = "foundation-probabilistic-baselines.v1"
REFERENCE_NOTIONAL_CNY = 100_000.0
MARKET_EXIT_SLIPPAGE_RATE = 0.0005
VALID_BOARDS = ("MAIN", "CHINEXT", "STAR", "BEIJING")


class ProbabilisticBaselineError(ValueError):
    pass


@dataclass(frozen=True)
class BaselinePartition:
    x: np.ndarray
    dates: np.ndarray
    boards: np.ndarray
    instruments: np.ndarray
    target_return: np.ndarray
    direction: np.ndarray
    sample_weight: np.ndarray

    def __post_init__(self) -> None:
        lengths = {
            len(self.x),
            len(self.dates),
            len(self.boards),
            len(self.instruments),
            len(self.target_return),
            len(self.direction),
            len(self.sample_weight),
        }
        if lengths != {len(self.x)} or len(self.x) == 0:
            raise ProbabilisticBaselineError(
                "PROBABILISTIC_BASELINE_PARTITION_INVALID",
            )


def _round_cny(values: np.ndarray) -> np.ndarray:
    cents = np.nextafter(values * 100.0 + 0.5, np.inf)
    return np.floor(cents) / 100.0


def fee_adjusted_returns(
    gross_returns: np.ndarray,
    boards: np.ndarray,
    execution_dates: np.ndarray,
    terminal_dates: np.ndarray,
) -> np.ndarray:
    """Vectorized equivalent of the frozen Decimal 100k fee policy."""
    gross = np.asarray(gross_returns, dtype=np.float64)
    board = np.asarray(boards)
    execution = np.asarray(execution_dates)
    terminal = np.asarray(terminal_dates)
    if (
        gross.ndim != 1
        or any(values.ndim != 1 for values in (board, execution, terminal))
        or len({len(gross), len(board), len(execution), len(terminal)}) != 1
        or not np.all(np.isfinite(gross))
        or np.any(gross <= -1.0)
        or not np.all(np.isin(board, VALID_BOARDS))
    ):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_LABEL_INPUT_INVALID",
        )

    pre_cutoff_transfer = np.where(board == "BEIJING", 0.000025, 0.00002)
    buy_transfer_rate = np.where(
        execution >= "20220429",
        0.00001,
        pre_cutoff_transfer,
    )
    sell_transfer_rate = np.where(
        terminal >= "20220429",
        0.00001,
        pre_cutoff_transfer,
    )
    stamp_rate = np.where(terminal >= "20230828", 0.0005, 0.001)

    buy_commission = 30.0
    buy_transfer = _round_cny(REFERENCE_NOTIONAL_CNY * buy_transfer_rate)
    buy_fees = buy_commission + buy_transfer

    sell_gross = (
        REFERENCE_NOTIONAL_CNY
        * (1.0 + gross)
        * (1.0 - MARKET_EXIT_SLIPPAGE_RATE)
    )
    sell_commission = _round_cny(np.maximum(5.0, sell_gross * 0.0003))
    sell_transfer = _round_cny(sell_gross * sell_transfer_rate)
    stamp_duty = _round_cny(sell_gross * stamp_rate)
    return (
        sell_gross
        - sell_commission
        - sell_transfer
        - stamp_duty
        - REFERENCE_NOTIONAL_CNY
        - buy_fees
    ) / (REFERENCE_NOTIONAL_CNY + buy_fees)


def normalized_weights(sample_weight: np.ndarray) -> np.ndarray:
    weights = np.asarray(sample_weight, dtype=np.float64)
    if (
        weights.ndim != 1
        or len(weights) == 0
        or not np.all(np.isfinite(weights))
        or np.any(weights <= 0)
    ):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_WEIGHT_INVALID",
        )
    return weights / np.mean(weights)


def weighted_quantiles(
    values: np.ndarray,
    quantiles: tuple[float, ...] = DEFAULT_QUANTILES,
    *,
    sample_weight: np.ndarray,
) -> np.ndarray:
    samples = np.asarray(values, dtype=np.float64)
    weights = np.asarray(sample_weight, dtype=np.float64)
    requested = np.asarray(quantiles, dtype=np.float64)
    if (
        samples.ndim != 1
        or weights.ndim != 1
        or len(samples) != len(weights)
        or len(samples) == 0
        or not np.all(np.isfinite(samples))
        or np.any(weights <= 0)
        or not np.all(np.isfinite(weights))
        or requested.ndim != 1
        or len(requested) == 0
        or np.any(requested <= 0)
        or np.any(requested >= 1)
        or np.any(np.diff(requested) <= 0)
    ):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_QUANTILE_INPUT_INVALID",
        )
    order = np.argsort(samples, kind="stable")
    ordered = samples[order]
    cumulative = np.cumsum(weights[order])
    indices = np.searchsorted(
        cumulative,
        requested * cumulative[-1],
        side="left",
    )
    return ordered[np.minimum(indices, len(ordered) - 1)]


def historical_baseline_predictions(
    training: BaselinePartition,
    rows: int,
    *,
    quantiles: tuple[float, ...] = DEFAULT_QUANTILES,
) -> dict[str, np.ndarray]:
    if rows <= 0:
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_PREDICTION_ROWS_INVALID",
        )
    probability = float(
        np.average(training.direction, weights=training.sample_weight),
    )
    values = weighted_quantiles(
        training.target_return,
        quantiles,
        sample_weight=training.sample_weight,
    )
    predictions = {
        "pWin": np.full(rows, probability, dtype=np.float32),
    }
    predictions.update(
        {
            f"q{round(alpha * 100):02d}": np.full(
                rows,
                value,
                dtype=np.float32,
            )
            for alpha, value in zip(quantiles, values, strict=True)
        }
    )
    return predictions
