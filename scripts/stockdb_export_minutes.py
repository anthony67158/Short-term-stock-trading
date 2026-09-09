#!/usr/bin/env python3
"""Export bounded StockDB minute data for a causal replay manifest."""

import argparse
import gzip
import json
import os
import re
import sys


CODE = re.compile(r"^\d{6}$")
DATE = re.compile(r"^\d{8}$")
MAX_DATES = 160
MAX_CODES_PER_DATE = 6000


def load_manifest(path):
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    rows = payload.get("dates") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_DATES:
        raise ValueError("StockDB分钟导出日期数量无效")
    normalized = []
    for row in rows:
        date = str((row or {}).get("date") or "")
        codes = (row or {}).get("codes")
        if not DATE.fullmatch(date):
            raise ValueError("StockDB分钟导出日期无效")
        if (
            not isinstance(codes, list)
            or not 1 <= len(codes) <= MAX_CODES_PER_DATE
        ):
            raise ValueError("StockDB分钟导出股票数量无效")
        unique = sorted(set(str(code) for code in codes))
        if len(unique) != len(codes) or any(
            not CODE.fullmatch(code) for code in unique
        ):
            raise ValueError("StockDB分钟导出股票代码无效")
        normalized.append({"date": date, "codes": unique})
    if len({row["date"] for row in normalized}) != len(normalized):
        raise ValueError("StockDB分钟导出日期重复")
    return sorted(normalized, key=lambda row: row["date"])


def safe_output_directory(path):
    output = os.path.abspath(path)
    home = os.path.expanduser("~")
    if not output.startswith(home + os.sep):
        raise ValueError("StockDB分钟导出目录必须位于当前用户主目录")
    os.makedirs(output, exist_ok=True)
    return output


def load_sdk(stockdb_root):
    root = os.path.abspath(stockdb_root)
    pybao = os.path.join(root, "pybao")
    if not os.path.isfile(os.path.join(pybao, "stock_sdk.py")):
        raise ValueError("StockDB SDK目录无效")
    sys.path.insert(0, pybao)
    import stock_sdk

    stock_sdk.init(
        host="127.0.0.1",
        port=7899,
        socket_timeout=120,
        warm=False,
    )
    return stock_sdk.rd


def clean_rows(rows, date, code):
    result = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        timestamp = re.sub(r"\D", "", str(row.get("date") or ""))
        row_code = str(row.get("code") or code)
        if (
            len(timestamp) == 14
            and timestamp.startswith(date)
            and row_code == code
        ):
            result.append(row)
    return result


def write_date_file(rd, row, output_dir, batch_size):
    date = row["date"]
    target = os.path.join(output_dir, f"{date}.json.gz")
    if os.path.isfile(target) and os.path.getsize(target) > 64:
        return {"date": date, "codes": len(row["codes"]), "skipped": True}
    temporary = target + ".part"
    written = 0
    with gzip.open(temporary, "wt", encoding="utf-8") as handle:
        handle.write('{"date":')
        json.dump(date, handle)
        handle.write(',"codes":{')
        first = True
        codes = row["codes"]
        for start in range(0, len(codes), batch_size):
            chunk = codes[start:start + batch_size]
            values = rd.get_data(
                chunk,
                start=date,
                end=date,
                frequency="1m",
                fq=None,
            )
            if not isinstance(values, dict):
                raise RuntimeError("StockDB分钟批量响应结构无效")
            for code in chunk:
                if not first:
                    handle.write(",")
                first = False
                json.dump(code, handle)
                handle.write(":")
                rows = clean_rows(values.get(code), date, code)
                json.dump(
                    rows,
                    handle,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    allow_nan=False,
                )
                written += len(rows)
        handle.write("}}")
    os.replace(temporary, target)
    return {
        "date": date,
        "codes": len(row["codes"]),
        "bars": written,
        "output": target,
        "skipped": False,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--stockdb-root")
    parser.add_argument("--output-dir")
    parser.add_argument("--batch-size", type=int, default=250)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    rows = load_manifest(args.manifest)
    if args.dry_run:
        print(json.dumps({
            "ok": True,
            "dates": len(rows),
            "maximumCodes": max(len(row["codes"]) for row in rows),
        }))
        return
    if not args.stockdb_root or not args.output_dir:
        raise ValueError("StockDB分钟导出缺少目录参数")
    batch_size = max(50, min(500, int(args.batch_size)))
    output_dir = safe_output_directory(args.output_dir)
    rd = load_sdk(args.stockdb_root)
    for index, row in enumerate(rows, 1):
        result = write_date_file(rd, row, output_dir, batch_size)
        print(json.dumps({
            "progress": index,
            "total": len(rows),
            **result,
        }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
