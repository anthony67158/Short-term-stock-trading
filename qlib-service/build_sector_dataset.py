"""Tushare 6000-point sector history backfill and daily incremental dataset."""
import argparse
import datetime as dt
import gzip
import json
import os

import numpy as np

from sector_factors import build_sector_training_frame, frame_to_dataset
from tushare_client import TushareClient


HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CACHE = os.path.join(HERE, "sector_raw_cache.json.gz")
DEFAULT_OUT = os.path.join(HERE, "sector_dataset.npz")
RAW_CACHE_KEY = (
    os.environ.get("SECTOR_MODEL_PREFIX", "sectormodel/")
    + "raw_cache.json.gz"
)


def _sector_key(row):
    return (
        str((row or {}).get("ts_code") or ""),
        str((row or {}).get("trade_date") or "").replace("-", ""),
    )


def merge_sector_panel(daily_rows, flow_rows, index_rows):
    index_map = {
        str(row.get("ts_code") or ""): row
        for row in index_rows or []
        if row.get("ts_code")
    }
    flow_map = {
        _sector_key(row): row
        for row in flow_rows or []
        if all(_sector_key(row))
    }
    merged = {}
    for row in daily_rows or []:
        code, trade_date = _sector_key(row)
        if not code or not trade_date:
            continue
        current = dict(merged.get((code, trade_date), {}))
        current.update(row)
        current["trade_date"] = trade_date
        metadata = index_map.get(code) or {}
        current.setdefault("name", metadata.get("name"))
        current.setdefault("index_type", metadata.get("type"))
        current.setdefault("company_num", metadata.get("count"))
        flow = flow_map.get((code, trade_date))
        if flow:
            current.update(flow)
            current["trade_date"] = trade_date
        else:
            for field in (
                "net_amount",
                "net_buy_amount",
                "net_sell_amount",
                "pct_change_stock",
            ):
                current.setdefault(field, None)
        merged[(code, trade_date)] = current
    return sorted(
        merged.values(),
        key=lambda row: (row["trade_date"], row["ts_code"]),
    )


def _index_catalog(client):
    rows = client.ths_index(exchange="A")
    catalog = {}
    for row in rows:
        code = str(row.get("ts_code") or "")
        index_type = str(row.get("type") or "")
        if code and index_type in {"N", "I"}:
            catalog[code] = row
    if not catalog:
        raise RuntimeError("Tushare ths_index 未返回A股概念/行业指数")
    return list(catalog.values())


def _open_dates(client, start_date, end_date):
    return [
        str(row.get("cal_date") or "")
        for row in client.trade_cal(
            start_date=start_date,
            end_date=end_date,
        )
        if str(row.get("is_open") or "") == "1"
        and str(row.get("cal_date") or "").isdigit()
    ]


def update_sector_panel(
    client,
    existing=None,
    start_date="20230101",
    end_date=None,
):
    end_date = end_date or dt.date.today().strftime("%Y%m%d")
    catalog = _index_catalog(client)
    existing = list(existing or [])
    existing_dates = {
        str(row.get("trade_date") or "").replace("-", "")
        for row in existing
        if row.get("trade_date")
    }
    if not existing:
        daily_rows = []
        flow_rows = []
        for index, metadata in enumerate(catalog, 1):
            code = metadata["ts_code"]
            daily_rows.extend(client.ths_daily(
                ts_code=code,
                start_date=start_date,
                end_date=end_date,
            ))
            if str(metadata.get("type") or "") == "I":
                try:
                    flow_rows.extend(client.moneyflow_ind_ths(
                        ts_code=code,
                        start_date=start_date,
                        end_date=end_date,
                    ))
                except RuntimeError:
                    pass
            if index % 25 == 0:
                print(
                    f"[sector-backfill] {index}/{len(catalog)}",
                    flush=True,
                )
        return merge_sector_panel(daily_rows, flow_rows, catalog)

    missing_dates = [
        date for date in _open_dates(client, start_date, end_date)
        if date not in existing_dates
    ]
    additions = []
    for trade_date in missing_dates:
        daily = client.ths_daily(trade_date=trade_date)
        try:
            flow = client.moneyflow_ind_ths(trade_date=trade_date)
        except RuntimeError:
            flow = []
        additions.extend(merge_sector_panel(daily, flow, catalog))
    combined = {}
    for row in [*existing, *additions]:
        code, trade_date = _sector_key(row)
        if code and trade_date:
            combined[(code, trade_date)] = {
                **combined.get((code, trade_date), {}),
                **row,
                "trade_date": trade_date,
            }
    return sorted(
        combined.values(),
        key=lambda row: (row["trade_date"], row["ts_code"]),
    )


def load_cache(path):
    if not os.path.exists(path):
        return []
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, list) else []


def save_cache(path, rows):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        json.dump(rows, handle, ensure_ascii=False, separators=(",", ":"))


def sync_cache_from_oss(path):
    if os.path.exists(path):
        return False
    try:
        from model_lib import _oss_bucket
        bucket = _oss_bucket()
        if bucket is None:
            return False
        content = bucket.get_object(RAW_CACHE_KEY).read()
        with open(path, "wb") as handle:
            handle.write(content)
        load_cache(path)
        return True
    except Exception:
        try:
            os.remove(path)
        except OSError:
            pass
        return False


def upload_cache_to_oss(path):
    try:
        from model_lib import _oss_bucket
        bucket = _oss_bucket()
        if bucket is None:
            return False
        bucket.put_object_from_file(RAW_CACHE_KEY, path)
        return True
    except Exception:
        return False


def build_dataset_file(rows, output_path):
    import pandas as pd

    frame = build_sector_training_frame(pd.DataFrame(rows))
    dataset = frame_to_dataset(frame)
    os.makedirs(
        os.path.dirname(os.path.abspath(output_path)),
        exist_ok=True,
    )
    np.savez_compressed(output_path, **dataset)
    return {
        "samples": int(len(dataset["X"])),
        "dates": int(len(set(dataset["dates"].astype(str)))),
        "sectors": int(len(set(dataset["codes"].astype(str)))),
        "dataEndDate": str(max(dataset["dates"].astype(str))),
        "features": len(dataset["feat_names"]),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-date", default="20230101")
    parser.add_argument(
        "--end-date",
        default=dt.date.today().strftime("%Y%m%d"),
    )
    parser.add_argument("--cache", default=DEFAULT_CACHE)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--no-oss-cache", action="store_true")
    args = parser.parse_args()

    if not args.no_oss_cache:
        sync_cache_from_oss(args.cache)
    existing = load_cache(args.cache)
    client = TushareClient()
    rows = update_sector_panel(
        client,
        existing,
        start_date=args.start_date,
        end_date=args.end_date,
    )
    if not rows:
        raise RuntimeError("Tushare 未返回可用板块历史")
    save_cache(args.cache, rows)
    if not args.no_oss_cache:
        upload_cache_to_oss(args.cache)
    result = build_dataset_file(rows, args.out)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
