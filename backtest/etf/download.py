"""Explicit manual ETF history export; never imported by production training.

API contracts: tushare.pro/document/2?doc_id=127, 199, 120, 19.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "qlib-service"))
from tushare_client import TushareClient


def unique(rows, fields):
    result = {}
    for row in rows:
        key = tuple(row.get(field) for field in fields)
        if key in result and result[key] != row:
            raise ValueError("Conflicting duplicate records")
        result[key] = row
    return list(result.values())


def export(config, output):
    client = TushareClient(timeout=25, retries=1)
    output.mkdir(parents=True, exist_ok=True)
    config_hash = hashlib.sha256(config.read_bytes()).hexdigest()
    spec = json.loads(config.read_text())
    calendar = client.rows("trade_cal", {
        "exchange": "SSE", "start_date": spec["dataStart"],
        "end_date": spec["end"], "is_open": "1",
    }, "cal_date,is_open")
    assets = []
    for asset in spec["assets"]:
        cache = output / (asset["code"] + ".json")
        if cache.exists():
            record = json.loads(cache.read_text())
            if record.get("configHash") != config_hash:
                raise ValueError("Cache belongs to another frozen experiment")
        else:
            basic = client.rows("fund_basic", {
                "ts_code": asset["code"], "market": "E",
            }, "ts_code,name,list_date,delist_date,status")
            basic = [row for row in basic if row["ts_code"] == asset["code"]]
            if len(basic) != 1:
                raise ValueError("ETF metadata missing or ambiguous")
            daily, adj = [], []
            for year in range(int(spec["dataStart"][:4]), int(spec["end"][:4]) + 1):
                params = {
                    "ts_code": asset["code"],
                    "start_date": max(spec["dataStart"], f"{year}0101"),
                    "end_date": min(spec["end"], f"{year}1231"),
                }
                rows = client.rows("fund_daily", params,
                    "ts_code,trade_date,open,high,low,close,pre_close,vol,amount")
                factors = client.rows("fund_adj", params,
                    "ts_code,trade_date,adj_factor")
                if len(rows) >= 5000 or len(factors) >= 2000:
                    raise ValueError("API row cap reached")
                daily.extend(rows)
                adj.extend(factors)
            dividends = client.rows("fund_div", {"ts_code": asset["code"]},
                "ts_code,ann_date,imp_anndate,div_proc,record_date,ex_date,pay_date,div_cash")
            record = {
                **asset, "basic": basic[0], "configHash": config_hash,
                "fetchedAt": int(time.time() * 1000),
                "daily": unique(daily, ["trade_date"]),
                "adj": unique(adj, ["trade_date"]),
                "dividends": unique(dividends, ["ex_date", "record_date", "div_proc"]),
            }
            temporary = cache.with_suffix(".tmp")
            temporary.write_text(json.dumps(record, ensure_ascii=False))
            os.replace(temporary, cache)
        assets.append(record)
        print(json.dumps({"code": asset["code"], "daily": len(record["daily"]),
                          "adj": len(record["adj"]), "dividends": len(record["dividends"])}),
              flush=True)
    artifact = {
        "schemaVersion": "etf-history.v1", "configHash": config_hash,
        "calendar": sorted({row["cal_date"] for row in calendar}),
        "assets": assets,
    }
    encoded = json.dumps(artifact, ensure_ascii=False).encode()
    key = hashlib.sha256(encoded).hexdigest()
    target = output / f"history-{key}.json"
    if not target.exists():
        target.write_bytes(encoded)
    (output / "manifest.json").write_text(json.dumps({
        "file": target.name, "sha256": key, "configHash": config_hash,
    }))
    print(json.dumps({"ok": True, "file": str(target), "sha256": key}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("experiment.json"))
    parser.add_argument("--output", type=Path, default=ROOT / "backtest/cache/etf-v1")
    args = parser.parse_args()
    try:
        export(args.config, args.output)
    except Exception as error:
        # Provider errors can echo request information; do not print their body.
        print(json.dumps({"ok": False, "errorType": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
