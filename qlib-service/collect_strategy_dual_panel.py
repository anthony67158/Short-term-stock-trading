"""Collect resumable RAW/QFQ point-in-time panels for StrategySpec v2."""

import argparse
from datetime import datetime
import json

import numpy as np

from collect_strategy_raw_panel import (
    _date,
    _number,
    _panel_path,
    _rows_by_date,
    prediction_codes,
    write_panel,
)
from tushare_client import SAFE_MAX_PER_MIN, TushareClient


def _date_value(value):
    return datetime.strptime(_date(value), "%Y%m%d")


def _aligned(rows, dates, field):
    mapped = _rows_by_date(rows)
    return np.asarray(
        [_number(mapped.get(date), field) for date in dates],
        dtype=np.float64,
    )


def _st_on_date(trade_date, name_changes):
    for row in name_changes or []:
        start = _date(row.get("start_date"))
        end = _date(row.get("end_date")) or "99991231"
        name = str(row.get("name") or "")
        if start and start <= trade_date <= end and "ST" in name.upper():
            return True
    return False


def build_dual_price_panel(
    code,
    daily_rows,
    adjustment_rows,
    basic_rows,
    moneyflow_rows,
    name_changes,
    suspensions,
    *,
    name,
    list_date,
    requested_start,
    requested_end,
    market_regimes,
):
    daily = _rows_by_date(daily_rows)
    dates = sorted(daily)
    if not dates:
        raise ValueError("no daily rows for %s" % code)
    adjustment = _aligned(adjustment_rows, dates, "adj_factor")
    if not np.isfinite(adjustment).all() or np.any(adjustment <= 0):
        raise ValueError("adjustment factors must cover every trade date")
    latest_adjustment = float(adjustment[-1])
    qfq_scale = adjustment / latest_adjustment

    def raw(field):
        values = np.asarray(
            [_number(daily[date], field) for date in dates],
            dtype=np.float64,
        )
        if not np.isfinite(values).all():
            raise ValueError("daily %s must cover every trade date" % field)
        return values

    raw_open = raw("open")
    raw_high = raw("high")
    raw_low = raw("low")
    raw_close = raw("close")
    volume = raw("vol")
    amount = raw("amount")
    suspension_dates = {
        _date(row.get("trade_date"))
        for row in suspensions or []
        if _date(row.get("trade_date"))
    }
    regimes = {
        str(key).replace("-", ""): str(value)
        for key, value in (market_regimes or {}).items()
    }
    missing_regime_dates = [
        date for date in dates
        if regimes.get(date) not in {
            "TREND_STRONG",
            "RANGE",
            "TRANSITION",
            "RISK_OFF",
            "UNKNOWN",
        }
    ]
    if missing_regime_dates:
        raise ValueError("market regime missing for one or more trade dates")
    listed = _date_value(list_date)
    listing_days = np.asarray([
        max(0, (_date_value(date) - listed).days + 1)
        for date in dates
    ], dtype=np.int64)
    return {
        "code": np.asarray(str(code).strip().upper()),
        "name": np.asarray(str(name or code)),
        "timeframe": np.asarray("1d"),
        "dates": np.asarray(dates),
        "o": raw_open,
        "h": raw_high,
        "l": raw_low,
        "c": raw_close,
        "qfq_o": raw_open * qfq_scale,
        "qfq_h": raw_high * qfq_scale,
        "qfq_l": raw_low * qfq_scale,
        "qfq_c": raw_close * qfq_scale,
        "v": volume,
        "amount": amount,
        "adj_factor": adjustment,
        "b_turnover_rate_f": _aligned(
            basic_rows,
            dates,
            "turnover_rate_f",
        ),
        "volume_ratio": _aligned(
            basic_rows,
            dates,
            "volume_ratio",
        ),
        "m_net_mf_amount": _aligned(
            moneyflow_rows,
            dates,
            "net_mf_amount",
        ),
        "is_st": np.asarray([
            _st_on_date(date, name_changes) for date in dates
        ], dtype=np.bool_),
        "is_suspended": np.asarray([
            date in suspension_dates for date in dates
        ], dtype=np.bool_),
        "listing_days": listing_days,
        "bar_complete": np.ones(len(dates), dtype=np.bool_),
        "market_regime": np.asarray([regimes[date] for date in dates]),
        "price_adjustment": np.asarray("DUAL_QFQ_RAW"),
        "signal_price": np.asarray("QFQ"),
        "execution_price": np.asarray("RAW"),
        "volume_unit": np.asarray("HANDS"),
        "amount_unit": np.asarray("THOUSAND_CNY"),
        "requested_start": np.asarray(_date(requested_start)),
        "requested_end": np.asarray(_date(requested_end)),
    }


def _panel_is_current(path, start_date, end_date):
    try:
        with np.load(path, allow_pickle=False) as panel:
            return (
                str(panel["price_adjustment"]) == "DUAL_QFQ_RAW"
                and str(panel["requested_start"]) == _date(start_date)
                and str(panel["requested_end"]) == _date(end_date)
                and len(panel["dates"]) > 0
            )
    except (OSError, ValueError, KeyError):
        return False


def collect_dual_panels(
    client,
    codes,
    *,
    start_date,
    end_date,
    output_dir,
    market_regimes,
    force=False,
    on_progress=None,
):
    basics = {
        row["ts_code"]: row
        for row in client.stock_basic(
            fields="ts_code,name,list_date",
        )
        if row.get("ts_code")
    }
    summary = {
        "requested": len(codes),
        "collected": 0,
        "skipped": 0,
        "failed": 0,
        "failures": {},
    }
    for index, code in enumerate(sorted(set(codes)), start=1):
        path = _panel_path(output_dir, code)
        if not force and _panel_is_current(path, start_date, end_date):
            summary["skipped"] += 1
        else:
            try:
                basic = basics.get(code) or {}
                panel = build_dual_price_panel(
                    code,
                    client.daily(
                        code,
                        start_date=start_date,
                        end_date=end_date,
                    ),
                    client.adj_factor(
                        code,
                        start_date=start_date,
                        end_date=end_date,
                    ),
                    client.daily_basic(
                        ts_code=code,
                        start_date=start_date,
                        end_date=end_date,
                        fields=(
                            "trade_date,turnover_rate_f,volume_ratio"
                        ),
                    ),
                    client.moneyflow(
                        ts_code=code,
                        start_date=start_date,
                        end_date=end_date,
                        fields="trade_date,net_mf_amount",
                    ),
                    client.namechange(
                        code,
                        start_date=start_date,
                        end_date=end_date,
                    ),
                    client.suspend_d(
                        code,
                        start_date=start_date,
                        end_date=end_date,
                    ),
                    name=basic.get("name") or code,
                    list_date=basic.get("list_date") or start_date,
                    requested_start=start_date,
                    requested_end=end_date,
                    market_regimes=market_regimes,
                )
                write_panel(path, panel)
                summary["collected"] += 1
            except Exception as error:
                summary["failed"] += 1
                summary["failures"][code] = type(error).__name__
        if on_progress:
            on_progress(index, len(codes), code, summary)
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--market-regimes",
        required=True,
        help="JSON: date-to-market-regime mapping",
    )
    parser.add_argument(
        "--max-per-minute",
        type=int,
        default=SAFE_MAX_PER_MIN,
    )
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    codes = prediction_codes(args.predictions)
    with open(args.market_regimes, encoding="utf-8") as handle:
        regime_payload = json.load(handle)
    market_regimes = (
        regime_payload.get("regimes")
        if isinstance(regime_payload, dict)
        and isinstance(regime_payload.get("regimes"), dict)
        else regime_payload
    )
    if not isinstance(market_regimes, dict):
        raise ValueError("market-regimes must contain a date mapping")
    summary = collect_dual_panels(
        TushareClient(max_per_min=args.max_per_minute),
        codes,
        start_date=args.start,
        end_date=args.end,
        output_dir=args.out,
        market_regimes=market_regimes,
        force=args.force,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if summary["failed"]:
        print("STRATEGY_DUAL_PANEL_INCOMPLETE")
        return 2
    print("STRATEGY_DUAL_PANEL_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
