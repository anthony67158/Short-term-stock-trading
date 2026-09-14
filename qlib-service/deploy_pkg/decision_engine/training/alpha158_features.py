"""Official Alpha158-style daily feature calculation for local OHLCV data.

The feature order follows microsoft/qlib Alpha158DL.get_feature_config.
This module is research-only and does not change the production 36-factor
``/predict`` contract.
"""

from __future__ import annotations

import numpy as np


WINDOWS = (5, 10, 20, 30, 60)
KBAR_NAMES = (
    "KMID",
    "KLEN",
    "KMID2",
    "KUP",
    "KUP2",
    "KLOW",
    "KLOW2",
    "KSFT",
    "KSFT2",
)
PRICE_NAMES = ("OPEN0", "HIGH0", "LOW0", "VWAP0")
ROLLING_NAMES = (
    "ROC",
    "MA",
    "STD",
    "BETA",
    "RSQR",
    "RESI",
    "MAX",
    "MIN",
    "QTLU",
    "QTLD",
    "RANK",
    "RSV",
    "IMAX",
    "IMIN",
    "IMXD",
    "CORR",
    "CORD",
    "CNTP",
    "CNTN",
    "CNTD",
    "SUMP",
    "SUMN",
    "SUMD",
    "VMA",
    "VSTD",
    "WVMA",
    "VSUMP",
    "VSUMN",
    "VSUMD",
)
FEATURE_NAMES = (
    *KBAR_NAMES,
    *PRICE_NAMES,
    *(
        f"{name}{window}"
        for name in ROLLING_NAMES
        for window in WINDOWS
    ),
)

EPSILON = 1e-12


def _divide(left, right):
    left = np.asarray(left, dtype=np.float64)
    right = np.asarray(right, dtype=np.float64)
    return np.divide(
        left,
        right,
        out=np.full(np.broadcast_shapes(left.shape, right.shape), np.nan),
        where=np.isfinite(right) & (np.abs(right) > EPSILON),
    )


def _rolling_windows(values, window):
    values = np.asarray(values, dtype=np.float64)
    if len(values) < window:
        return np.empty((0, window), dtype=np.float64)
    return np.lib.stride_tricks.sliding_window_view(values, window)


def _assign_full(output, values, window):
    if len(values):
        output[window - 1:] = values


def _regression(window_values):
    matrix = np.asarray(window_values, dtype=np.float64)
    if not len(matrix):
        empty = np.asarray([], dtype=np.float64)
        return empty, empty, empty
    x = np.arange(1, matrix.shape[1] + 1, dtype=np.float64)
    mask = np.isfinite(matrix)
    count = mask.sum(axis=1).astype(np.float64)
    safe = np.where(mask, matrix, 0.0)
    x_values = np.where(mask, x, 0.0)
    sum_x = x_values.sum(axis=1)
    sum_x2 = (x_values * x_values).sum(axis=1)
    sum_y = safe.sum(axis=1)
    sum_y2 = (safe * safe).sum(axis=1)
    sum_xy = (safe * x).sum(axis=1)
    denominator = count * sum_x2 - sum_x * sum_x
    slope = np.divide(
        count * sum_xy - sum_x * sum_y,
        denominator,
        out=np.full(len(matrix), np.nan),
        where=np.abs(denominator) > EPSILON,
    )
    mean_x = _divide(sum_x, count)
    mean_y = _divide(sum_y, count)
    intercept = mean_y - slope * mean_x
    residual = matrix[:, -1] - (
        slope * matrix.shape[1] + intercept
    )
    correlation_denominator = np.sqrt(
        np.maximum(
            0.0,
            denominator
            * (count * sum_y2 - sum_y * sum_y),
        ),
    )
    correlation = np.divide(
        count * sum_xy - sum_x * sum_y,
        correlation_denominator,
        out=np.full(len(matrix), np.nan),
        where=correlation_denominator > EPSILON,
    )
    return slope, correlation * correlation, residual


def _rolling_correlation(left, right):
    left = np.asarray(left, dtype=np.float64)
    right = np.asarray(right, dtype=np.float64)
    mask = np.isfinite(left) & np.isfinite(right)
    count = mask.sum(axis=1).astype(np.float64)
    x = np.where(mask, left, 0.0)
    y = np.where(mask, right, 0.0)
    sum_x = x.sum(axis=1)
    sum_y = y.sum(axis=1)
    covariance = count * (x * y).sum(axis=1) - sum_x * sum_y
    variance_x = count * (x * x).sum(axis=1) - sum_x * sum_x
    variance_y = count * (y * y).sum(axis=1) - sum_y * sum_y
    denominator = np.sqrt(np.maximum(0.0, variance_x * variance_y))
    return np.divide(
        covariance,
        denominator,
        out=np.full(len(left), np.nan),
        where=denominator > EPSILON,
    )


def _rolling_rank(matrix):
    current = matrix[:, -1, None]
    valid = np.isfinite(matrix)
    count = valid.sum(axis=1)
    less = ((matrix < current) & valid).sum(axis=1)
    equal = ((matrix == current) & valid).sum(axis=1)
    average_rank = less + (equal + 1) / 2
    return np.divide(
        average_rank,
        count,
        out=np.full(len(matrix), np.nan),
        where=count > 0,
    )


def _rolling_index(matrix, kind):
    valid = np.isfinite(matrix)
    replacement = -np.inf if kind == "max" else np.inf
    prepared = np.where(valid, matrix, replacement)
    index = (
        np.argmax(prepared, axis=1)
        if kind == "max"
        else np.argmin(prepared, axis=1)
    ).astype(np.float64) + 1
    index[~valid.any(axis=1)] = np.nan
    return index


def alpha158_matrix(
    opens,
    highs,
    lows,
    closes,
    volumes,
    amounts,
):
    """Return an ``n x 158`` matrix in official Alpha158 feature order."""
    o = np.asarray(opens, dtype=np.float64)
    h = np.asarray(highs, dtype=np.float64)
    l = np.asarray(lows, dtype=np.float64)
    c = np.asarray(closes, dtype=np.float64)
    v = np.asarray(volumes, dtype=np.float64)
    a = np.asarray(amounts, dtype=np.float64)
    if not (
        o.shape == h.shape == l.shape == c.shape == v.shape == a.shape
        and o.ndim == 1
    ):
        raise ValueError("Alpha158 OHLCV arrays must be aligned vectors")

    n = len(c)
    columns = {}
    price_range = h - l
    upper_body = np.maximum(o, c)
    lower_body = np.minimum(o, c)
    columns["KMID"] = _divide(c - o, o)
    columns["KLEN"] = _divide(price_range, o)
    columns["KMID2"] = _divide(c - o, price_range + EPSILON)
    columns["KUP"] = _divide(h - upper_body, o)
    columns["KUP2"] = _divide(h - upper_body, price_range + EPSILON)
    columns["KLOW"] = _divide(lower_body - l, o)
    columns["KLOW2"] = _divide(lower_body - l, price_range + EPSILON)
    columns["KSFT"] = _divide(2 * c - h - l, o)
    columns["KSFT2"] = _divide(
        2 * c - h - l,
        price_range + EPSILON,
    )
    columns["OPEN0"] = _divide(o, c)
    columns["HIGH0"] = _divide(h, c)
    columns["LOW0"] = _divide(l, c)
    columns["VWAP0"] = _divide(_divide(a, v), c)

    previous_close = np.roll(c, 1)
    previous_close[0] = np.nan
    price_ratio = _divide(c, previous_close)
    previous_volume = np.roll(v, 1)
    previous_volume[0] = np.nan
    volume_ratio = _divide(v, previous_volume)
    price_change = c - previous_close
    volume_change = v - previous_volume
    positive_price = np.maximum(price_change, 0.0)
    negative_price = np.maximum(-price_change, 0.0)
    absolute_price = np.abs(price_change)
    positive_volume = np.maximum(volume_change, 0.0)
    negative_volume = np.maximum(-volume_change, 0.0)
    absolute_volume = np.abs(volume_change)
    weighted_move = np.abs(price_ratio - 1.0) * v

    for window in WINDOWS:
        close_windows = _rolling_windows(c, window)
        high_windows = _rolling_windows(h, window)
        low_windows = _rolling_windows(l, window)
        volume_windows = _rolling_windows(v, window)
        log_volume_windows = _rolling_windows(np.log(v + 1.0), window)
        price_ratio_windows = _rolling_windows(price_ratio, window)
        log_volume_ratio_windows = _rolling_windows(
            np.log(volume_ratio + 1.0),
            window,
        )
        positive_price_windows = _rolling_windows(
            positive_price,
            window,
        )
        negative_price_windows = _rolling_windows(
            negative_price,
            window,
        )
        absolute_price_windows = _rolling_windows(
            absolute_price,
            window,
        )
        positive_volume_windows = _rolling_windows(
            positive_volume,
            window,
        )
        negative_volume_windows = _rolling_windows(
            negative_volume,
            window,
        )
        absolute_volume_windows = _rolling_windows(
            absolute_volume,
            window,
        )
        weighted_move_windows = _rolling_windows(
            weighted_move,
            window,
        )
        current_close = c[window - 1:]
        current_volume = v[window - 1:]
        slope, rsquare, residual = _regression(close_windows)
        maximum = np.nanmax(high_windows, axis=1)
        minimum = np.nanmin(low_windows, axis=1)
        idx_max = _rolling_index(high_windows, "max")
        idx_min = _rolling_index(low_windows, "min")

        roc = np.full(len(close_windows), np.nan, dtype=np.float64)
        if len(roc) > 1:
            roc[1:] = _divide(c[:-window], c[window:])
        values = {
            "ROC": roc,
            "MA": _divide(
                np.nanmean(close_windows, axis=1),
                current_close,
            ),
            "STD": _divide(
                np.nanstd(close_windows, axis=1, ddof=1),
                current_close,
            ),
            "BETA": _divide(slope, current_close),
            "RSQR": rsquare,
            "RESI": _divide(residual, current_close),
            "MAX": _divide(maximum, current_close),
            "MIN": _divide(minimum, current_close),
            "QTLU": _divide(
                np.nanquantile(close_windows, 0.8, axis=1),
                current_close,
            ),
            "QTLD": _divide(
                np.nanquantile(close_windows, 0.2, axis=1),
                current_close,
            ),
            "RANK": _rolling_rank(close_windows),
            "RSV": _divide(current_close - minimum, maximum - minimum),
            "IMAX": idx_max / window,
            "IMIN": idx_min / window,
            "IMXD": (idx_max - idx_min) / window,
            "CORR": _rolling_correlation(
                close_windows,
                log_volume_windows,
            ),
            "CORD": _rolling_correlation(
                price_ratio_windows,
                log_volume_ratio_windows,
            ),
            "CNTP": np.nanmean(price_change[None, :] > 0, axis=0)[
                :len(close_windows)
            ],
            "CNTN": np.nanmean(price_change[None, :] < 0, axis=0)[
                :len(close_windows)
            ],
            "SUMP": _divide(
                np.nansum(positive_price_windows, axis=1),
                np.nansum(absolute_price_windows, axis=1) + EPSILON,
            ),
            "SUMN": _divide(
                np.nansum(negative_price_windows, axis=1),
                np.nansum(absolute_price_windows, axis=1) + EPSILON,
            ),
            "VMA": _divide(
                np.nanmean(volume_windows, axis=1),
                current_volume + EPSILON,
            ),
            "VSTD": _divide(
                np.nanstd(volume_windows, axis=1, ddof=1),
                current_volume + EPSILON,
            ),
            "WVMA": _divide(
                np.nanstd(weighted_move_windows, axis=1, ddof=1),
                np.nanmean(weighted_move_windows, axis=1) + EPSILON,
            ),
            "VSUMP": _divide(
                np.nansum(positive_volume_windows, axis=1),
                np.nansum(absolute_volume_windows, axis=1) + EPSILON,
            ),
            "VSUMN": _divide(
                np.nansum(negative_volume_windows, axis=1),
                np.nansum(absolute_volume_windows, axis=1) + EPSILON,
            ),
        }
        values["CNTD"] = values["CNTP"] - values["CNTN"]
        values["SUMD"] = values["SUMP"] - values["SUMN"]
        values["VSUMD"] = values["VSUMP"] - values["VSUMN"]

        # Correct CNTP/CNTN to the matching rolling windows.
        up = _rolling_windows((price_change > 0).astype(float), window)
        down = _rolling_windows((price_change < 0).astype(float), window)
        values["CNTP"] = np.mean(up, axis=1)
        values["CNTN"] = np.mean(down, axis=1)
        values["CNTD"] = values["CNTP"] - values["CNTN"]

        for name in ROLLING_NAMES:
            output = np.full(n, np.nan, dtype=np.float64)
            _assign_full(output, values[name], window)
            columns[f"{name}{window}"] = output

    matrix = np.column_stack([columns[name] for name in FEATURE_NAMES])
    matrix[~np.isfinite(matrix)] = np.nan
    return matrix.astype(np.float32)
