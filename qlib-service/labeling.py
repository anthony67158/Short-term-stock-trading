"""Leak-free labels shared by daily challenger training pipelines."""

import math

import numpy as np


LOSS = -1
TIMEOUT = 0
PROFIT = 1


def _one_dimensional(values, name):
    array = np.asarray(values, dtype=float)
    if array.ndim != 1 or not len(array):
        raise ValueError(f"{name} must be a non-empty one-dimensional array")
    if not np.isfinite(array).all():
        raise ValueError(f"{name} must contain only finite values")
    return array


def triple_barrier_outcome(
    *,
    entry_price,
    future_high,
    future_low,
    take_profit_pct,
    stop_loss_pct,
    same_bar_policy="loss",
):
    """Return PROFIT, LOSS, or TIMEOUT for a long trade's future path."""
    highs = _one_dimensional(future_high, "future_high")
    lows = _one_dimensional(future_low, "future_low")
    if len(highs) != len(lows):
        raise ValueError("future_high and future_low must have equal length")
    if not math.isfinite(entry_price) or entry_price <= 0:
        raise ValueError("entry_price must be positive and finite")
    if (
        not math.isfinite(take_profit_pct)
        or take_profit_pct <= 0
        or not math.isfinite(stop_loss_pct)
        or stop_loss_pct <= 0
    ):
        raise ValueError("barrier percentages must be positive and finite")
    if same_bar_policy not in ("loss", "profit"):
        raise ValueError("same_bar_policy must be 'loss' or 'profit'")

    upper = entry_price * (1.0 + take_profit_pct)
    lower = entry_price * (1.0 - stop_loss_pct)
    for high, low in zip(highs, lows):
        hit_profit = high >= upper
        hit_loss = low <= lower
        if hit_profit and hit_loss:
            return LOSS if same_bar_policy == "loss" else PROFIT
        if hit_loss:
            return LOSS
        if hit_profit:
            return PROFIT
    return TIMEOUT


def forward_path_labels(*, close, high, low, index, horizons=(1, 3, 5)):
    """Compute close return, MFE, and MAE using only each forward horizon."""
    closes = _one_dimensional(close, "close")
    highs = _one_dimensional(high, "high")
    lows = _one_dimensional(low, "low")
    if not (len(closes) == len(highs) == len(lows)):
        raise ValueError("close, high, and low must have equal length")
    if not isinstance(index, (int, np.integer)) or index < 0:
        raise ValueError("index must be a non-negative integer")

    normalized_horizons = tuple(int(horizon) for horizon in horizons)
    if (
        not normalized_horizons
        or any(horizon <= 0 for horizon in normalized_horizons)
        or len(set(normalized_horizons)) != len(normalized_horizons)
    ):
        raise ValueError("horizons must contain unique positive integers")
    if index + max(normalized_horizons) >= len(closes):
        raise ValueError("full forward horizon is not available")

    entry = closes[index]
    if entry <= 0:
        raise ValueError("entry close must be positive")

    labels = {}
    for horizon in normalized_horizons:
        path = slice(index + 1, index + horizon + 1)
        labels[f"return_{horizon}d"] = closes[index + horizon] / entry - 1.0
        labels[f"mfe_{horizon}d"] = np.max(highs[path]) / entry - 1.0
        labels[f"mae_{horizon}d"] = np.min(lows[path]) / entry - 1.0
    return labels
