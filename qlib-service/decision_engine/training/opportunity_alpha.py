"""Causal stock-day targets for an Alpha158 opportunity prior."""

from __future__ import annotations

import bisect
from collections import defaultdict

import numpy as np

from .review_dataset import opportunity_modes


OPPORTUNITY_ALPHA_TARGET_VERSION = "alpha158-opportunity-target.v1"


def _compact_date(value):
    digits = "".join(
        character
        for character in str(value or "")
        if character.isdigit()
    )
    return digits[:8] if len(digits) >= 8 else ""


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
    modes = opportunity_modes(dataset)
    if not (
        dates.shape
        == codes.shape
        == rewards.shape
        == stress_rewards.shape
        == starts.shape
        == ends.shape
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
        selected = max(
            indices,
            key=lambda index: (
                rewards[index],
                stress_rewards[index],
                -index,
            ),
        )
        rows.append((
            feature_date,
            code,
            rewards[selected],
            stress_rewards[selected],
            min(starts[indices]),
            max(ends[indices]),
            len(indices),
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
    }
