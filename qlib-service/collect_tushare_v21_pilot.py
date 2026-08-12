"""Collect a bounded Tushare cache for the V2.1 exogenous-data pilot."""

import argparse
import json
import os
import tempfile
from datetime import datetime, timedelta

import numpy as np

from intraday_v21_exogenous_pilot import select_pilot_indices
from tushare_client import TushareClient
from tushare_v21_research import _failure_status


STOCK_SOURCES = (
    (
        "daily_basic",
        "ts_code,trade_date,turnover_rate_f,volume_ratio,circ_mv",
    ),
    (
        "moneyflow",
        "ts_code,trade_date,buy_lg_amount,sell_lg_amount,"
        "buy_elg_amount,sell_elg_amount,net_mf_amount",
    ),
    (
        "stk_auction",
        "ts_code,trade_date,price,pre_close,turnover_rate,volume_ratio",
    ),
)


def _fetch(client, api_name, params, fields, failures, failure_key):
    try:
        return client.rows(api_name, params, fields)
    except Exception as error:  # noqa: BLE001
        status, _detail = _failure_status(error)
        failures[failure_key] = status
        return []


def collect_pilot_cache(client, codes, *, start_date, end_date):
    """Use one bounded date range per source and stock."""
    codes = sorted({str(code) for code in codes})
    failures = {}
    common = {
        "start_date": str(start_date),
        "end_date": str(end_date),
    }
    market = _fetch(
        client,
        "moneyflow_mkt_dc",
        common,
        "trade_date,net_amount_rate,buy_elg_amount_rate",
        failures,
        "market_moneyflow",
    )
    stocks = {}
    calls = 1
    denied_sources = set()
    for code in codes:
        stock = {}
        for api_name, fields in STOCK_SOURCES:
            stock_key = "auction" if api_name == "stk_auction" else api_name
            failure_key = f"{code}.{api_name}"
            if api_name in denied_sources:
                stock[stock_key] = []
                failures[failure_key] = "permission_denied"
                continue
            stock[stock_key] = _fetch(
                client,
                api_name,
                {"ts_code": code, **common},
                fields,
                failures,
                failure_key,
            )
            calls += 1
            if failures.get(failure_key) == "permission_denied":
                denied_sources.add(api_name)
        stocks[code] = stock
    return {
        "meta": {
            "version": 1,
            "codes": len(codes),
            "start_date": str(start_date),
            "end_date": str(end_date),
            "calls": calls,
            "failures": failures,
            "causal_policy": (
                "daily_basic/moneyflow/market_moneyflow use strictly prior "
                "trade_date; opening auction may use the same trade_date"
            ),
        },
        "stocks": stocks,
        "market_moneyflow": market,
    }


def pilot_scope(dataset_path, *, max_codes=24, max_dates=90):
    if not 1 <= max_codes <= 50:
        raise ValueError("max_codes 必须在1到50之间")
    if not 15 <= max_dates <= 180:
        raise ValueError("max_dates 必须在15到180之间")
    with np.load(dataset_path, allow_pickle=False) as data:
        codes = data["codes"].astype(str)
        dates = data["dates"].astype(str)
    selected = select_pilot_indices(
        codes,
        dates,
        max_codes=max_codes,
        max_dates=max_dates,
    )
    if not len(selected):
        raise ValueError("V2.1 小样本范围为空")
    selected_codes = sorted(set(codes[selected]))
    selected_dates = sorted(set(dates[selected]))
    first = datetime.strptime(selected_dates[0][:10], "%Y-%m-%d")
    start = (first - timedelta(days=10)).strftime("%Y%m%d")
    end = selected_dates[-1].replace("-", "")[:8]
    return {
        "codes": selected_codes,
        "dates": selected_dates,
        "start_date": start,
        "end_date": end,
        "samples": int(len(selected)),
    }


def write_cache(path, cache):
    output = os.path.abspath(path)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=".v21-exogenous-",
        suffix=".json",
        dir=os.path.dirname(output),
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(cache, handle, ensure_ascii=False, separators=(",", ":"))
        os.replace(temporary, output)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise
    return output


def main():
    parser = argparse.ArgumentParser(
        description="采集V2.1小样本外生数据，不启动全量训练",
    )
    parser.add_argument("--data", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-codes", type=int, default=24)
    parser.add_argument("--max-dates", type=int, default=90)
    args = parser.parse_args()
    scope = pilot_scope(
        args.data,
        max_codes=args.max_codes,
        max_dates=args.max_dates,
    )
    cache = collect_pilot_cache(
        TushareClient(max_per_min=30),
        scope["codes"],
        start_date=scope["start_date"],
        end_date=scope["end_date"],
    )
    cache["meta"]["sample_dates"] = scope["dates"]
    cache["meta"]["samples"] = scope["samples"]
    output = write_cache(args.out, cache)
    print(json.dumps({
        "out": output,
        "codes": cache["meta"]["codes"],
        "sample_dates": len(scope["dates"]),
        "samples": scope["samples"],
        "calls": cache["meta"]["calls"],
        "failures": cache["meta"]["failures"],
    }, ensure_ascii=False))
    print("V21_TUSHARE_PILOT_CACHE_OK")


if __name__ == "__main__":
    main()
