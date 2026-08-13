"""Collect resumable RAW Tushare panels for strategy walk-forward research."""

import argparse
import json
import os
import tempfile

import numpy as np

from tushare_client import SAFE_MAX_PER_MIN, TushareClient


DAILY_FIELDS = "trade_date,open,high,low,close,vol,amount"
BASIC_FIELDS = "trade_date,turnover_rate_f,volume_ratio"
MONEYFLOW_FIELDS = "trade_date,net_mf_amount"
REQUIRED_PANEL_KEYS = frozenset({
    "dates",
    "o",
    "h",
    "l",
    "c",
    "v",
    "amount",
    "price_adjustment",
    "volume_unit",
    "amount_unit",
    "requested_start",
    "requested_end",
})


def _normalise_code(value):
    return str(value).strip().upper()


def _date(value):
    return str(value or "").replace("-", "")[:8]


def _number(row, key):
    value = None if row is None else row.get(key)
    try:
        number = float(value)
    except (TypeError, ValueError):
        return np.nan
    return number if np.isfinite(number) else np.nan


def _rows_by_date(rows):
    output = {}
    for row in rows or []:
        trade_date = _date(row.get("trade_date"))
        if trade_date:
            output[trade_date] = row
    return output


def prediction_codes(path):
    with np.load(path, allow_pickle=False) as data:
        if "codes" not in data.files:
            raise ValueError("prediction snapshot missing codes")
        codes = data["codes"].astype(str)
    output = sorted({_normalise_code(code) for code in codes if str(code)})
    if not output:
        raise ValueError("prediction snapshot contains no codes")
    return output


def build_raw_panel(
    code,
    daily_rows,
    basic_rows,
    moneyflow_rows,
    *,
    requested_start,
    requested_end,
):
    daily = _rows_by_date(daily_rows)
    basic = _rows_by_date(basic_rows)
    moneyflow = _rows_by_date(moneyflow_rows)
    dates = sorted(daily)
    if not dates:
        raise ValueError("no daily rows for %s" % _normalise_code(code))

    def daily_values(key):
        return np.asarray(
            [_number(daily[trade_date], key) for trade_date in dates],
            dtype=np.float64,
        )

    def aligned_values(source, key):
        return np.asarray(
            [_number(source.get(trade_date), key) for trade_date in dates],
            dtype=np.float64,
        )

    return {
        "code": np.asarray(_normalise_code(code)),
        "dates": np.asarray(dates),
        "o": daily_values("open"),
        "h": daily_values("high"),
        "l": daily_values("low"),
        "c": daily_values("close"),
        "v": daily_values("vol"),
        "amount": daily_values("amount"),
        "b_turnover_rate_f": aligned_values(basic, "turnover_rate_f"),
        "b_volume_ratio": aligned_values(basic, "volume_ratio"),
        "m_net_mf_amount": aligned_values(moneyflow, "net_mf_amount"),
        "price_adjustment": np.asarray("RAW"),
        "volume_unit": np.asarray("HANDS"),
        "amount_unit": np.asarray("THOUSAND_CNY"),
        "requested_start": np.asarray(_date(requested_start)),
        "requested_end": np.asarray(_date(requested_end)),
    }


def _panel_path(output_dir, code):
    return os.path.join(
        os.path.abspath(output_dir),
        _normalise_code(code).replace(".", "_") + ".npz",
    )


def _metadata(data, key):
    value = data[key]
    if value.size != 1:
        return ""
    return str(value.reshape(-1)[0])


def panel_matches_request(path, *, start_date, end_date):
    try:
        with np.load(path, allow_pickle=False) as data:
            if not REQUIRED_PANEL_KEYS.issubset(data.files):
                return False
            return (
                _metadata(data, "price_adjustment") == "RAW"
                and _metadata(data, "volume_unit") == "HANDS"
                and _metadata(data, "amount_unit") == "THOUSAND_CNY"
                and _metadata(data, "requested_start") == _date(start_date)
                and _metadata(data, "requested_end") == _date(end_date)
                and len(data["dates"]) > 0
            )
    except (OSError, ValueError, KeyError):
        return False


def write_panel(path, panel):
    output = os.path.abspath(path)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=".strategy-raw-",
        suffix=".npz",
        dir=os.path.dirname(output),
    )
    os.close(descriptor)
    try:
        np.savez_compressed(temporary, **panel)
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)
    return output


def collect_raw_panels(
    client,
    codes,
    *,
    start_date,
    end_date,
    output_dir,
    force=False,
    on_progress=None,
):
    codes = sorted({_normalise_code(code) for code in codes})
    summary = {
        "requested": len(codes),
        "collected": 0,
        "skipped": 0,
        "failed": 0,
        "failures": {},
    }
    for index, code in enumerate(codes, start=1):
        path = _panel_path(output_dir, code)
        if not force and panel_matches_request(
            path,
            start_date=start_date,
            end_date=end_date,
        ):
            summary["skipped"] += 1
        else:
            try:
                panel = build_raw_panel(
                    code,
                    client.daily(
                        code,
                        start_date=start_date,
                        end_date=end_date,
                        fields=DAILY_FIELDS,
                    ),
                    client.daily_basic(
                        ts_code=code,
                        start_date=start_date,
                        end_date=end_date,
                        fields=BASIC_FIELDS,
                    ),
                    client.moneyflow(
                        ts_code=code,
                        start_date=start_date,
                        end_date=end_date,
                        fields=MONEYFLOW_FIELDS,
                    ),
                    requested_start=start_date,
                    requested_end=end_date,
                )
                write_panel(path, panel)
                summary["collected"] += 1
            except Exception as error:  # Continue so a rerun can resume.
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
        "--max-per-minute",
        type=int,
        default=SAFE_MAX_PER_MIN,
    )
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)

    def progress(index, total, code, summary):
        if index == total or index % 10 == 0:
            print(
                "[%d/%d] %s collected=%d skipped=%d failed=%d"
                % (
                    index,
                    total,
                    code,
                    summary["collected"],
                    summary["skipped"],
                    summary["failed"],
                ),
                flush=True,
            )

    summary = collect_raw_panels(
        TushareClient(max_per_min=args.max_per_minute),
        prediction_codes(args.predictions),
        start_date=args.start,
        end_date=args.end,
        output_dir=args.out,
        force=args.force,
        on_progress=progress,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if summary["failed"]:
        print("STRATEGY_RAW_PANEL_INCOMPLETE")
        return 2
    print("STRATEGY_RAW_PANEL_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
