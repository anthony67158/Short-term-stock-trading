"""Causal best-action stock-day targets for an Alpha158 opportunity prior."""

from __future__ import annotations

import bisect
from collections import defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np

from .review_dataset import opportunity_fill_labels, opportunity_modes


OPPORTUNITY_ALPHA_TARGET_VERSION = "alpha158-opportunity-target.v1"
SHANGHAI = ZoneInfo("Asia/Shanghai")


def _compact_date(value):
    digits = "".join(
        character
        for character in str(value or "")
        if character.isdigit()
    )
    return digits[:8] if len(digits) >= 8 else ""


def date_start_ms(value):
    date = _compact_date(value)
    if not date:
        raise ValueError("Alpha机会日期无效")
    return int(
        datetime.strptime(date, "%Y%m%d")
        .replace(tzinfo=SHANGHAI)
        .timestamp()
        * 1000
    )


def percentile_by_date(scores, dates):
    values = np.asarray(scores, dtype=np.float64)
    groups = np.asarray(dates).astype(str)
    if values.shape != groups.shape or values.ndim != 1:
        raise ValueError("Alpha机会分位输入未对齐")
    output = np.zeros(len(values), dtype=np.float64)
    for date in np.unique(groups):
        indices = np.flatnonzero(groups == date)
        if len(indices) == 1:
            output[indices[0]] = 0.5
            continue
        order = np.argsort(values[indices], kind="stable")
        ranks = np.empty(len(indices), dtype=np.float64)
        ranks[order] = np.arange(len(indices), dtype=np.float64)
        output[indices] = ranks / (len(indices) - 1)
    return output


def momentum_by_code(percentiles, codes, dates, *, lag=5):
    values = np.asarray(percentiles, dtype=np.float64)
    code_values = np.asarray(codes).astype(str)
    date_values = np.asarray(dates).astype(str)
    if not (
        values.shape == code_values.shape == date_values.shape
    ) or values.ndim != 1:
        raise ValueError("Alpha机会动量输入未对齐")
    output = np.zeros(len(values), dtype=np.float64)
    grouped = defaultdict(list)
    for index, code in enumerate(code_values):
        grouped[code].append(index)
    for indices in grouped.values():
        ordered = sorted(indices, key=lambda index: date_values[index])
        for position in range(lag, len(ordered)):
            current = ordered[position]
            previous = ordered[position - lag]
            output[current] = values[current] - values[previous]
    return output


def rolling_mature_rank_ic(
    scores,
    targets,
    dates,
    label_end_ms,
    output_dates,
    *,
    window,
):
    scores = np.asarray(scores, dtype=np.float64)
    targets = np.asarray(targets, dtype=np.float64)
    dates = np.asarray(dates).astype(str)
    ends = np.asarray(label_end_ms, dtype=np.int64)
    if not (
        scores.shape == targets.shape == dates.shape == ends.shape
    ) or scores.ndim != 1:
        raise ValueError("Alpha机会RankIC输入未对齐")
    daily = []
    for date in np.unique(dates):
        indices = np.flatnonzero(dates == date)
        correlation = np.nan
        if (
            len(indices) >= 5
            and np.std(scores[indices]) > 1e-12
            and np.std(targets[indices]) > 1e-12
        ):
            correlation = float(np.corrcoef(
                np.argsort(np.argsort(scores[indices], kind="stable")),
                np.argsort(np.argsort(targets[indices], kind="stable")),
            )[0, 1])
        daily.append((date, int(ends[indices].max()), correlation))
    result = {}
    for date in sorted(set(map(str, output_dates))):
        current_ms = date_start_ms(date)
        mature = [
            value
            for _source_date, end_ms, value in daily
            if end_ms < current_ms and np.isfinite(value)
        ]
        result[date] = (
            float(np.mean(mature[-window:]))
            if mature
            else 0.0
        )
    return result


def causal_feature_date(trade_date, mode, available_dates):
    date = _compact_date(trade_date)
    if not date:
        return None
    dates = list(available_dates)
    if str(mode or "").upper() == "CLOSE":
        return date if date in dates else None
    if str(mode or "").upper() != "INTRADAY":
        return None
    position = bisect.bisect_left(dates, date)
    return dates[position - 1] if position > 0 else None


def aggregate_stock_day_targets(dataset, available_dates):
    dates = np.asarray(dataset["dates_opportunity"]).astype(str)
    codes = np.asarray(dataset["codes_opportunity"]).astype(str)
    rewards = np.asarray(
        dataset["y_opportunity_r"],
        dtype=np.float64,
    )
    stress_rewards = np.asarray(
        dataset.get(
            "y_opportunity_r_stress10",
            dataset["y_opportunity_r"],
        ),
        dtype=np.float64,
    )
    starts = np.asarray(
        dataset["label_start_ms_opportunity"],
        dtype=np.int64,
    )
    ends = np.asarray(
        dataset["label_end_ms_opportunity"],
        dtype=np.int64,
    )
    fills = opportunity_fill_labels(dataset).astype(bool)
    modes = opportunity_modes(dataset)
    if not (
        dates.shape
        == codes.shape
        == rewards.shape
        == stress_rewards.shape
        == starts.shape
        == ends.shape
        == fills.shape
        == modes.shape
    ):
        raise ValueError("Alpha机会目标数组未对齐")
    market_dates = sorted({
        _compact_date(value)
        for value in available_dates
        if _compact_date(value)
    })
    grouped = defaultdict(list)
    for index in range(len(rewards)):
        feature_date = causal_feature_date(
            dates[index],
            modes[index],
            market_dates,
        )
        if feature_date is None:
            continue
        grouped[(feature_date, codes[index])].append(index)

    rows = []
    for (feature_date, code), indices in sorted(grouped.items()):
        filled_indices = [
            index
            for index in indices
            if fills[index]
        ]
        selected = (
            max(
                filled_indices,
                key=lambda index: (
                    rewards[index],
                    stress_rewards[index],
                    -index,
                ),
            )
            if filled_indices
            else None
        )
        take_path = selected is not None and rewards[selected] > 0
        rows.append((
            feature_date,
            code,
            rewards[selected] if take_path else 0.0,
            stress_rewards[selected] if take_path else 0.0,
            min(starts[indices]),
            max(ends[indices]),
            len(indices),
            len(filled_indices),
        ))
    return {
        "schema_version": OPPORTUNITY_ALPHA_TARGET_VERSION,
        "dates": np.asarray([row[0] for row in rows], dtype="<U8"),
        "codes": np.asarray([row[1] for row in rows], dtype="<U6"),
        "y_best_net_r": np.asarray(
            [row[2] for row in rows],
            dtype=np.float32,
        ),
        "y_best_net_r_stress10": np.asarray(
            [row[3] for row in rows],
            dtype=np.float32,
        ),
        "label_start_ms": np.asarray(
            [row[4] for row in rows],
            dtype=np.int64,
        ),
        "label_end_ms": np.asarray(
            [row[5] for row in rows],
            dtype=np.int64,
        ),
        "path_counts": np.asarray(
            [row[6] for row in rows],
            dtype=np.int16,
        ),
        "filled_path_counts": np.asarray(
            [row[7] for row in rows],
            dtype=np.int16,
        ),
    }
