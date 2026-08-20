"""Point-in-time sector features and T+1 / T+5 cross-sectional labels."""
import math

import numpy as np
import pandas as pd

from sector_contract import FEATURE_NAMES


def _number_series(frame, name, default=0.0):
    if name not in frame:
        return pd.Series(default, index=frame.index, dtype=float)
    return pd.to_numeric(frame[name], errors="coerce").fillna(default)


def _percentile_by_date(frame, column):
    return (
        frame.groupby("trade_date", sort=False)[column]
        .rank(method="average", pct=True)
        .fillna(0.5)
    )


def _streak(values):
    output = np.zeros(len(values), dtype=float)
    current = 0
    previous = 0
    for index, value in enumerate(values):
        direction = 1 if value > 0 else (-1 if value < 0 else 0)
        current = current + direction if direction and direction == previous else direction
        output[index] = current
        previous = direction
    return output


def _rolling_by_code(frame, column, window, operation):
    grouped = frame.groupby("ts_code", sort=False)[column]
    if operation == "mean":
        return grouped.transform(
            lambda values: values.rolling(window, min_periods=1).mean()
        )
    if operation == "std":
        return grouped.transform(
            lambda values: values.rolling(window, min_periods=2).std()
        ).fillna(0.0)
    raise ValueError(f"unsupported rolling operation: {operation}")


def _normalize_panel(panel):
    required = {"ts_code", "trade_date", "close"}
    missing = required.difference(panel.columns)
    if missing:
        raise ValueError(f"sector panel missing columns: {sorted(missing)}")
    frame = panel.copy()
    frame["ts_code"] = frame["ts_code"].astype(str)
    frame["trade_date"] = (
        frame["trade_date"].astype(str).str.replace("-", "", regex=False)
    )
    frame = frame[
        frame["trade_date"].str.fullmatch(r"\d{8}", na=False)
        & frame["ts_code"].str.fullmatch(r"\d{6}\.TI", na=False)
    ].copy()
    frame = frame.sort_values(
        ["trade_date", "ts_code"], kind="stable"
    ).reset_index(drop=True)
    for column in ("open", "high", "low", "close"):
        frame[column] = _number_series(frame, column, np.nan)
    frame = frame.dropna(subset=["open", "high", "low", "close"])
    return frame.reset_index(drop=True)


def build_sector_feature_frame(panel):
    """Build features using current and past rows only."""
    frame = _normalize_panel(panel)
    frame["currentPct"] = _number_series(frame, "pct_change")
    frame["volume"] = _number_series(frame, "vol")
    frame["turnover"] = _number_series(frame, "turnover_rate")
    frame["net_amount"] = _number_series(frame, "net_amount")
    frame["net_buy_amount"] = _number_series(frame, "net_buy_amount")
    frame["net_sell_amount"] = _number_series(frame, "net_sell_amount")
    frame["company_num"] = _number_series(frame, "company_num")
    frame["lead_pct"] = _number_series(frame, "pct_change_stock")
    flow_denominator = (
        frame["net_buy_amount"].abs()
        + frame["net_sell_amount"].abs()
    ).replace(0, np.nan)
    frame["flow_ratio"] = (
        frame["net_amount"] / flow_denominator * 100
    ).replace([np.inf, -np.inf], np.nan).fillna(0.0)

    frame["flow_positive"] = (frame["net_amount"] > 0).astype(float)
    positive_ratio = _rolling_by_code(
        frame, "flow_positive", 10, "mean"
    ) * 100
    streak = (
        frame.groupby("ts_code", sort=False)["net_amount"]
        .transform(lambda values: _streak(values.to_numpy(dtype=float)))
    )
    frame["flowStreak"] = streak
    frame["flowPersistence"] = np.clip(
        positive_ratio * 0.72
        + np.clip(streak, 0, 5) / 5 * 100 * 0.28,
        0,
        100,
    )

    recent_flow = _rolling_by_code(frame, "flow_ratio", 3, "mean")
    prior_flow = (
        frame.groupby("ts_code", sort=False)["flow_ratio"]
        .transform(
            lambda values: values.shift(3).rolling(3, min_periods=1).mean()
        )
        .fillna(recent_flow)
    )
    frame["flowAcceleration"] = np.clip(
        50 + (recent_flow - prior_flow) * 8,
        0,
        100,
    )

    amount_rank = _percentile_by_date(frame, "net_amount")
    ratio_rank = _percentile_by_date(frame, "flow_ratio")
    frame["fundStrength"] = np.clip(
        (amount_rank * 0.6 + ratio_rank * 0.4) * 100,
        0,
        100,
    )
    frame["priceFund"] = np.select(
        [
            (frame["flow_ratio"] > 0) & (frame["currentPct"] > 0),
            (frame["flow_ratio"] > 0) & (frame["currentPct"] <= 0),
            (frame["flow_ratio"] < 0) & (frame["currentPct"] >= 0),
            (frame["flow_ratio"] < 0) & (frame["currentPct"] < 0),
        ],
        [82.0, 92.0, 20.0, 10.0],
        default=50.0,
    )

    frame["upBreadthPct"] = np.clip(
        50 + frame["currentPct"] * 7,
        0,
        100,
    )
    frame["inflowBreadthPct"] = np.clip(
        50 + frame["flow_ratio"] * 5,
        0,
        100,
    )
    frame["limitUpPct"] = np.where(
        frame["lead_pct"] >= 9.5,
        np.maximum(1.0, 100 / frame["company_num"].replace(0, np.nan)),
        0.0,
    )
    frame["limitUpPct"] = frame["limitUpPct"].fillna(0.0).clip(0, 100)
    frame["breadth"] = np.clip(
        frame["upBreadthPct"] * 0.45
        + frame["inflowBreadthPct"] * 0.55,
        0,
        100,
    )
    frame["leadership"] = (
        _percentile_by_date(frame, "lead_pct") * 100
    ).clip(0, 100)
    liquidity_raw = frame["volume"] * (
        1 + frame["turnover"].clip(lower=0) / 100
    )
    frame["liquidity_raw"] = liquidity_raw
    frame["liquidity"] = (
        _percentile_by_date(frame, "liquidity_raw") * 100
    ).clip(0, 100)

    market_up = (
        frame.groupby("trade_date", sort=False)["currentPct"]
        .transform(lambda values: (values > 0).mean() * 100)
    )
    market_return = (
        frame.groupby("trade_date", sort=False)["currentPct"]
        .transform("mean")
    )
    frame["marketFit"] = np.clip(
        50 + (market_up - 50) * 0.4 + market_return * 3,
        0,
        100,
    )
    frame["momentum5Pct"] = (
        frame.groupby("ts_code", sort=False)["close"]
        .pct_change(5, fill_method=None)
        .mul(100)
        .replace([np.inf, -np.inf], np.nan)
        .fillna(0.0)
    )
    frame[FEATURE_NAMES] = (
        frame[FEATURE_NAMES]
        .replace([np.inf, -np.inf], np.nan)
        .fillna(0.0)
        .astype(float)
    )
    return frame.sort_values(
        ["trade_date", "ts_code"], kind="stable"
    ).reset_index(drop=True)


def _cross_section_label(frame, return_column):
    labels = pd.Series(np.nan, index=frame.index, dtype=float)
    valid = frame[return_column].notna()
    if not valid.any():
        return labels
    ranks = (
        frame.loc[valid]
        .groupby("trade_date", sort=False)[return_column]
        .rank(method="first", ascending=False)
    )
    counts = (
        frame.loc[valid]
        .groupby("trade_date", sort=False)[return_column]
        .transform("count")
    )
    threshold = np.ceil(counts * 0.2).clip(lower=1)
    labels.loc[valid] = (ranks <= threshold).astype(float)
    return labels


def build_sector_training_frame(panel):
    frame = build_sector_feature_frame(panel)
    grouped = frame.groupby("ts_code", sort=False)
    next_close = grouped["close"].shift(-1)
    next_open = grouped["open"].shift(-1)
    fifth_close = grouped["close"].shift(-5)
    frame["next_date"] = grouped["trade_date"].shift(-1)
    frame["week_end_date"] = grouped["trade_date"].shift(-5)
    frame["next_return"] = (next_close / frame["close"] - 1) * 100
    frame["week_return"] = (fifth_close / next_open - 1) * 100
    future_lows = pd.concat(
        [grouped["low"].shift(-offset) for offset in range(1, 6)],
        axis=1,
    )
    frame["week_max_drawdown"] = (
        future_lows.min(axis=1, skipna=False) / next_open - 1
    ) * 100
    frame["label_next"] = _cross_section_label(frame, "next_return")
    frame["label_week"] = _cross_section_label(frame, "week_return")
    return frame


def frame_to_dataset(frame):
    usable = frame[
        frame["label_next"].notna() & frame["label_week"].notna()
    ].copy()
    if usable.empty:
        raise ValueError("no mature sector labels")
    return {
        "X": usable[FEATURE_NAMES].to_numpy(dtype=np.float32),
        "y_next": usable["label_next"].to_numpy(dtype=np.int8),
        "y_week": usable["label_week"].to_numpy(dtype=np.int8),
        "dates": usable["trade_date"].to_numpy(dtype=str),
        "codes": usable["ts_code"].to_numpy(dtype=str),
        "week_drawdown": usable["week_max_drawdown"].to_numpy(
            dtype=np.float32
        ),
        "feat_names": np.asarray(FEATURE_NAMES, dtype=object),
    }
