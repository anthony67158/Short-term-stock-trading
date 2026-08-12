"""Causal exogenous features for a bounded V2.1 LightGBM pilot."""

import numpy as np


EXOGENOUS_FEATURE_NAMES = (
    "prev_turnover_rate_f",
    "prev_volume_ratio",
    "prev_net_mf_intensity",
    "prev_big_order_imbalance",
    "market_net_amount_rate",
    "market_buy_elg_amount_rate",
    "auction_gap",
    "auction_turnover_rate",
    "auction_volume_ratio",
)


def _finite(value, default=0.0):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return float(default)
    return result if np.isfinite(result) else float(default)


def _date(value):
    return str(value).replace("-", "")[:8]


def _rows_by_date(rows):
    result = {}
    for row in rows or []:
        trade_date = _date(row.get("trade_date", ""))
        if len(trade_date) == 8:
            result[trade_date] = row
    return result


def _latest_before(rows_by_date, trade_date):
    candidates = [
        value
        for date, value in rows_by_date.items()
        if date < trade_date
    ]
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda value: _date(value.get("trade_date", "")),
    )


def _big_order_imbalance(row):
    if not row:
        return 0.0
    buy = _finite(row.get("buy_lg_amount")) + _finite(
        row.get("buy_elg_amount")
    )
    sell = _finite(row.get("sell_lg_amount")) + _finite(
        row.get("sell_elg_amount")
    )
    gross = buy + sell
    return (buy - sell) / gross if gross > 1e-12 else 0.0


def _feature_row(code, trade_date, prepared):
    stock = prepared["stocks"].get(str(code), {})
    basic = _latest_before(stock.get("daily_basic", {}), trade_date)
    moneyflow = _latest_before(stock.get("moneyflow", {}), trade_date)
    market = _latest_before(prepared["market_moneyflow"], trade_date)
    auction = stock.get("auction", {}).get(trade_date)

    circ_mv = _finite((basic or {}).get("circ_mv"))
    net_mf = _finite((moneyflow or {}).get("net_mf_amount"))
    return np.asarray([
        _finite((basic or {}).get("turnover_rate_f")) / 100.0,
        _finite((basic or {}).get("volume_ratio")),
        net_mf / circ_mv if circ_mv > 1e-12 else 0.0,
        _big_order_imbalance(moneyflow),
        _finite((market or {}).get("net_amount_rate")) / 100.0,
        _finite((market or {}).get("buy_elg_amount_rate")) / 100.0,
        (
            _finite((auction or {}).get("price"))
            / _finite((auction or {}).get("pre_close"))
            - 1.0
        ) if _finite((auction or {}).get("pre_close")) > 1e-12 else 0.0,
        _finite((auction or {}).get("turnover_rate")) / 100.0,
        _finite((auction or {}).get("volume_ratio")),
    ], dtype=np.float32)


def _prepare_cache(cache):
    prepared = {
        "stocks": {},
        "market_moneyflow": _rows_by_date(cache.get("market_moneyflow")),
    }
    for code, stock in (cache.get("stocks") or {}).items():
        prepared["stocks"][str(code)] = {
            "daily_basic": _rows_by_date(stock.get("daily_basic")),
            "moneyflow": _rows_by_date(stock.get("moneyflow")),
            "auction": _rows_by_date(stock.get("auction")),
        }
    return prepared


def build_exogenous_features(codes, dates, cache):
    """Build a same-row feature matrix without using same-day close data."""
    codes = np.asarray(codes).astype(str)
    dates = np.asarray(dates).astype(str)
    if codes.shape != dates.shape or codes.ndim != 1:
        raise ValueError("外生特征 codes/dates 必须是一维且等长")
    prepared = _prepare_cache(cache or {})
    output = np.zeros(
        (len(codes), len(EXOGENOUS_FEATURE_NAMES)),
        dtype=np.float32,
    )
    stock_hit = auction_hit = market_hit = 0
    for index, (code, raw_date) in enumerate(zip(codes, dates)):
        trade_date = _date(raw_date)
        output[index] = _feature_row(code, trade_date, prepared)
        stock = prepared["stocks"].get(code, {})
        if (
            _latest_before(stock.get("daily_basic", {}), trade_date)
            or _latest_before(stock.get("moneyflow", {}), trade_date)
        ):
            stock_hit += 1
        if stock.get("auction", {}).get(trade_date):
            auction_hit += 1
        if _latest_before(prepared["market_moneyflow"], trade_date):
            market_hit += 1
    denominator = max(1, len(codes))
    coverage = {
        "stock_lagged": stock_hit / denominator,
        "market_lagged": market_hit / denominator,
        "auction": auction_hit / denominator,
    }
    return np.nan_to_num(output), coverage


def select_pilot_indices(codes, dates, *, max_codes=24, max_dates=90):
    """Select a recent bounded panel while retaining shared stock-date rows."""
    codes = np.asarray(codes).astype(str)
    dates = np.asarray(dates).astype(str)
    if codes.shape != dates.shape or codes.ndim != 1:
        raise ValueError("小样本 codes/dates 必须是一维且等长")
    if max_codes < 1 or max_dates < 1:
        raise ValueError("max_codes/max_dates 必须为正整数")
    selected_codes = sorted(set(codes))[:max_codes]
    code_mask = np.isin(codes, selected_codes)
    selected_dates = sorted(set(dates[code_mask]))[-max_dates:]
    return np.flatnonzero(code_mask & np.isin(dates, selected_dates))
