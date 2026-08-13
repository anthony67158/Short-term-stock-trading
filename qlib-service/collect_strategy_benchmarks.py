"""Collect complete benchmark closes for strategy walk-forward dates."""

import argparse
import json
import math
import os

import numpy as np

from tushare_client import TushareClient


DEFAULT_BENCHMARKS = {
    "CSI300": "000300.SH",
    "CSI1000": "000852.SH",
}


def prediction_dates(path):
    with np.load(path, allow_pickle=False) as data:
        if "dates" not in data.files:
            raise ValueError("prediction snapshot missing dates")
        dates = data["dates"].astype(str)
    output = sorted({
        str(date).replace("-", "")[:8]
        for date in dates
        if str(date)
    })
    if not output:
        raise ValueError("prediction snapshot contains no dates")
    return output


def collect_benchmarks(client, expected_dates, definitions=None):
    dates = sorted({
        str(date).replace("-", "")[:8]
        for date in expected_dates
    })
    if not dates:
        raise ValueError("expected benchmark dates must be non-empty")
    definitions = definitions or DEFAULT_BENCHMARKS
    benchmarks = {}
    sources = {}
    for name, code in definitions.items():
        rows = client.index_daily(
            code,
            start_date=dates[0],
            end_date=dates[-1],
        )
        series = {}
        for row in rows:
            date = str(row.get("trade_date", "")).replace("-", "")[:8]
            try:
                close = float(row.get("close"))
            except (TypeError, ValueError):
                continue
            if date in dates and math.isfinite(close) and close > 0:
                series[date] = close
        missing = sorted(set(dates) - set(series))
        if missing:
            raise ValueError(
                "%s benchmark missing dates: %s"
                % (name, ",".join(missing[:10]))
            )
        benchmarks[str(name)] = {
            date: series[date] for date in dates
        }
        sources[str(name)] = {
            "tsCode": str(code),
            "source": "TUSHARE_INDEX_DAILY",
            "priceField": "close",
        }
    return {
        "schemaVersion": "strategy-benchmarks.v1",
        "dateCount": len(dates),
        "startDate": dates[0],
        "endDate": dates[-1],
        "sources": sources,
        "benchmarks": benchmarks,
    }


def _write_json(path, payload):
    output = os.path.abspath(path)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    temporary = "%s.tmp.%d" % (output, os.getpid())
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-per-minute", type=int, default=30)
    args = parser.parse_args(argv)
    payload = collect_benchmarks(
        TushareClient(max_per_min=args.max_per_minute),
        prediction_dates(args.predictions),
    )
    _write_json(args.out, payload)
    print(json.dumps({
        "out": os.path.abspath(args.out),
        "dateCount": payload["dateCount"],
        "startDate": payload["startDate"],
        "endDate": payload["endDate"],
        "benchmarks": list(payload["benchmarks"]),
    }, ensure_ascii=False, indent=2))
    print("STRATEGY_BENCHMARKS_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
