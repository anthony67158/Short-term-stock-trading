"""Causal, scale-independent features shared by V2.1 training and inference."""

import numpy as np

from build_intraday_dataset import (
    FEATURE_NAMES as BASE_FEATURE_NAMES,
    _minute_features_from_arrays,
    _panel_arrays,
    _session_groups,
)


V21_FEATURE_NAMES = BASE_FEATURE_NAMES + (
    "momentum_30m",
    "realized_vol_30m",
    "session_return",
    "session_vwap_deviation",
    "session_range_position",
    "minutes_to_close",
)


def _rolling_realized_volatility(log_returns, window=6):
    squared = np.square(log_returns, dtype=np.float64)
    cumulative = np.concatenate(([0.0], np.cumsum(squared)))
    indices = np.arange(len(log_returns))
    left = np.maximum(0, indices - window + 1)
    totals = cumulative[indices + 1] - cumulative[left]
    counts = indices - left + 1
    return np.sqrt(totals / counts)


def _remaining_session_minutes(times):
    result = np.empty(len(times), dtype=np.float64)
    for index, value in enumerate(times):
        hour = int(value[11:13])
        minute = int(value[14:16])
        current = hour * 60 + minute
        if current <= 690:
            remaining = 690 - current + 120
        else:
            remaining = max(0, 900 - current)
        result[index] = remaining / 235.0
    return result


def _intraday_v21_features_from_arrays(times, arrays):
    base = _minute_features_from_arrays(times, arrays)
    closes = arrays["close"]
    opens = arrays["open"]
    highs = arrays["high"]
    lows = arrays["low"]
    volumes = arrays["vol"]

    log_returns = base[:, 0].astype(np.float64)
    momentum_30m = np.zeros(len(closes), dtype=np.float64)
    if len(closes) > 6:
        momentum_30m[6:] = np.log(closes[6:] / closes[:-6])
    realized_vol_30m = _rolling_realized_volatility(log_returns)

    session_return = np.zeros(len(closes), dtype=np.float64)
    session_vwap_deviation = np.zeros(len(closes), dtype=np.float64)
    session_range_position = np.zeros(len(closes), dtype=np.float64)
    for _date, indices in _session_groups(times):
        day = np.asarray(indices, dtype=int)
        day_closes = closes[day]
        day_volumes = volumes[day]
        session_return[day] = day_closes / opens[day[0]] - 1.0

        cumulative_volume = np.cumsum(day_volumes)
        cumulative_value = np.cumsum(day_closes * day_volumes)
        fallback_vwap = np.cumsum(day_closes) / np.arange(1, len(day) + 1)
        vwap = np.divide(
            cumulative_value,
            cumulative_volume,
            out=fallback_vwap,
            where=cumulative_volume > 0,
        )
        session_vwap_deviation[day] = day_closes / vwap - 1.0

        running_high = np.maximum.accumulate(highs[day])
        running_low = np.minimum.accumulate(lows[day])
        spread = running_high - running_low
        session_range_position[day] = np.divide(
            day_closes - running_low,
            spread,
            out=np.full(len(day), 0.5, dtype=np.float64),
            where=spread > 1e-12,
        ) - 0.5

    features = np.column_stack((
        base,
        momentum_30m,
        realized_vol_30m,
        session_return,
        session_vwap_deviation,
        session_range_position,
        _remaining_session_minutes(times),
    ))
    if not np.isfinite(features).all():
        raise ValueError("V2.1 盘中特征包含非有限数值")
    return features.astype(np.float32)


def intraday_v21_features(panel):
    times, arrays = _panel_arrays(panel)
    return _intraday_v21_features_from_arrays(times, arrays)
