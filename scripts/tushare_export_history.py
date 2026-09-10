#!/usr/bin/env python3
"""Export normalized Tushare history for the causal opportunity replay."""

import argparse
import gzip
import json
import math
import os
import re
import sqlite3
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "qlib-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from tushare_client import TushareClient  # noqa: E402


DATE = re.compile(r"^\d{8}$")
CODE = re.compile(r"^\d{6}$")
MAX_DATES = 160
MAX_CODES_PER_DATE = 6000
MINUTE_FIELDS = (
    "ts_code,trade_time,open,close,high,low,vol,amount"
)


def compact_date(value):
    text = re.sub(r"\D", "", str(value or ""))
    if not DATE.fullmatch(text):
        raise ValueError("Tushare历史日期无效")
    return text


def _number(value, *, default=None):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _code_parts(value):
    text = str(value or "").upper()
    match = re.fullmatch(r"(\d{6})\.(SH|SZ|BJ)", text)
    if not match:
        return None
    code, exchange = match.groups()
    valid = (
        (exchange == "SH" and code.startswith("6"))
        or (exchange == "SZ" and code.startswith(("0", "3")))
        or (exchange == "BJ" and code.startswith("920"))
    )
    return (code, exchange) if valid else None


def to_tushare_code(value):
    code = str(value or "")
    if not CODE.fullmatch(code):
        raise ValueError("Tushare分钟股票代码无效")
    if code.startswith("6"):
        return f"{code}.SH"
    if code.startswith(("0", "3")):
        return f"{code}.SZ"
    if code.startswith("920"):
        return f"{code}.BJ"
    raise ValueError("Tushare分钟股票代码市场无效")


def safe_directory(value):
    directory = Path(value).expanduser().resolve()
    home = Path.home().resolve()
    if directory == home or home not in directory.parents:
        raise ValueError("Tushare工作目录必须位于项目外的用户目录")
    if directory == ROOT or ROOT in directory.parents:
        raise ValueError("Tushare工作目录不得位于项目内")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return directory


def read_gzip_json(path):
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def write_gzip_json(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = target.with_suffix(target.suffix + ".part")
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    with open(temporary, "wb") as raw:
        os.chmod(temporary, 0o600)
        with gzip.GzipFile(
            fileobj=raw,
            mode="wb",
            compresslevel=6,
            mtime=0,
        ) as handle:
            handle.write(encoded)
    os.replace(temporary, target)


def normalize_daily_rows(daily_rows, basic_rows, names):
    basics = {
        row.get("ts_code"): row
        for row in basic_rows
        if isinstance(row, dict)
    }
    output = []
    for row in daily_rows:
        if not isinstance(row, dict):
            continue
        parts = _code_parts(row.get("ts_code"))
        if parts is None:
            continue
        code, _exchange = parts
        basic = basics.get(row.get("ts_code"), {})
        date = compact_date(row.get("trade_date"))
        name = str(names.get(code) or code)
        output.append({
            "date": date,
            "code": code,
            "name": name,
            "open": _number(row.get("open")),
            "high": _number(row.get("high")),
            "low": _number(row.get("low")),
            "close": _number(row.get("close")),
            "preClose": _number(row.get("pre_close")),
            "volume": _number(row.get("vol"), default=0.0) * 100,
            "amount": _number(row.get("amount"), default=0.0) * 1000,
            "turnover": _number(basic.get("turnover_rate")),
            "volumeRatio": _number(basic.get("volume_ratio")),
            "floatShare": _number(basic.get("float_share")),
            "isSt": bool(re.search(r"(?:\*?ST|退)", name, re.IGNORECASE)),
        })
    return sorted(output, key=lambda item: item["code"])


def normalize_fund_rows(rows):
    output = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        parts = _code_parts(row.get("ts_code"))
        if parts is None:
            continue
        code, _exchange = parts
        main = (
            _number(row.get("buy_lg_amount"), default=0.0)
            + _number(row.get("buy_elg_amount"), default=0.0)
            - _number(row.get("sell_lg_amount"), default=0.0)
            - _number(row.get("sell_elg_amount"), default=0.0)
        ) / 10_000
        retail = (
            _number(row.get("buy_sm_amount"), default=0.0)
            - _number(row.get("sell_sm_amount"), default=0.0)
        ) / 10_000
        output.append({
            "date": compact_date(row.get("trade_date")),
            "code": code,
            "mainNetYi": round(main, 6),
            "retailNetYi": round(retail, 6),
            "mainRatio": None,
        })
    return sorted(output, key=lambda item: item["code"])


def load_manifest(path):
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    rows = payload.get("dates") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_DATES:
        raise ValueError("Tushare分钟导出日期数量无效")
    normalized = []
    for row in rows:
        date = compact_date((row or {}).get("date"))
        codes = (row or {}).get("codes")
        if (
            not isinstance(codes, list)
            or not 1 <= len(codes) <= MAX_CODES_PER_DATE
        ):
            raise ValueError("Tushare分钟导出股票数量无效")
        unique = sorted(set(str(code) for code in codes))
        if len(unique) != len(codes) or any(
            not CODE.fullmatch(code) for code in unique
        ):
            raise ValueError("Tushare分钟导出股票代码无效")
        for code in unique:
            to_tushare_code(code)
        normalized.append({"date": date, "codes": unique})
    if len({row["date"] for row in normalized}) != len(normalized):
        raise ValueError("Tushare分钟导出日期重复")
    return sorted(normalized, key=lambda row: row["date"])


def _cached_rows(path, loader):
    if path.is_file():
        value = read_gzip_json(path)
        if isinstance(value, list):
            return value, True
        raise ValueError(f"Tushare缓存结构无效: {path.name}")
    value = loader()
    if not isinstance(value, list):
        raise ValueError("Tushare响应结构无效")
    write_gzip_json(path, value)
    return value, False


def _security_names(client, cache):
    rows, _cached = _cached_rows(
        cache,
        lambda: [
            row
            for status in ("L", "D", "P")
            for row in client.stock_basic(
                list_status=status,
                fields="ts_code,symbol,name,list_date,delist_date",
            )
        ],
    )
    names = {}
    for row in rows:
        parts = _code_parts((row or {}).get("ts_code"))
        if parts is not None:
            names[parts[0]] = str(row.get("name") or parts[0])
    if len(names) < 800:
        raise ValueError("Tushare有效证券主表不足800只")
    return names


def export_metadata(args):
    work = safe_directory(args.work_dir)
    source = work / "tushare-metadata"
    source.mkdir(parents=True, exist_ok=True, mode=0o700)
    days = source / "days"
    days.mkdir(parents=True, exist_ok=True, mode=0o700)
    client = TushareClient(max_per_min=args.max_per_min)
    names = _security_names(client, source / "securities.json.gz")
    calendar, _cached = _cached_rows(
        source / f"calendar-{args.start}-{args.end}.json.gz",
        lambda: client.trade_cal(
            start_date=args.start,
            end_date=args.end,
            fields="cal_date,is_open,pretrade_date",
        ),
    )
    open_dates = sorted({
        compact_date(row.get("cal_date"))
        for row in calendar
        if int(_number(row.get("is_open"), default=0)) == 1
    })
    if len(open_dates) < 187:
        raise ValueError(
            f"Tushare历史交易日不足187日: {len(open_dates)}"
        )

    all_daily = []
    all_funds = []
    for index, date in enumerate(open_dates, 1):
        day_path = days / f"{date}.json.gz"
        if day_path.is_file():
            payload = read_gzip_json(day_path)
            cached = True
        else:
            daily = client.rows(
                "daily",
                {"trade_date": date},
                "ts_code,trade_date,open,high,low,close,pre_close,vol,amount",
            )
            basic = client.rows(
                "daily_basic",
                {"trade_date": date},
                "ts_code,trade_date,turnover_rate,volume_ratio,float_share",
            )
            funds = client.rows(
                "moneyflow",
                {"trade_date": date},
                "ts_code,trade_date,buy_sm_amount,sell_sm_amount,"
                "buy_lg_amount,sell_lg_amount,buy_elg_amount,sell_elg_amount",
            )
            payload = {
                "date": date,
                "daily": normalize_daily_rows(daily, basic, names),
                "funds": normalize_fund_rows(funds),
            }
            write_gzip_json(day_path, payload)
            cached = False
        if (
            payload.get("date") != date
            or not isinstance(payload.get("daily"), list)
            or not isinstance(payload.get("funds"), list)
        ):
            raise ValueError(f"Tushare日缓存结构无效: {date}")
        all_daily.extend(payload["daily"])
        all_funds.extend(payload["funds"])
        if index == 1 or index % 10 == 0 or index == len(open_dates):
            print(json.dumps({
                "stage": "METADATA_DAY",
                "progress": index,
                "total": len(open_dates),
                "date": date,
                "daily": len(payload["daily"]),
                "funds": len(payload["funds"]),
                "cached": cached,
            }, ensure_ascii=False), flush=True)

    write_gzip_json(work / "daily.json.gz", all_daily)
    write_gzip_json(work / "funds.json.gz", all_funds)
    print(json.dumps({
        "stage": "METADATA_DONE",
        "dates": len(open_dates),
        "dailyRows": len(all_daily),
        "fundRows": len(all_funds),
    }, ensure_ascii=False), flush=True)


def _minute_rows(
    rows,
    expected_code,
    allowed_dates,
    *,
    include_exclusions=False,
):
    normalized = {}
    excluded_dates = set()
    expected_ts_code = to_tushare_code(expected_code)
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Tushare分钟行必须是对象")
        if str(row.get("ts_code") or "").upper() != expected_ts_code:
            raise ValueError("Tushare分钟股票代码与请求不一致")
        timestamp = re.sub(r"\D", "", str(row.get("trade_time") or ""))
        if len(timestamp) != 14 or timestamp[:8] not in allowed_dates:
            continue
        values = {
            field: _number(row.get(field))
            for field in ("open", "close", "high", "low", "vol", "amount")
        }
        if any(value is None for value in values.values()):
            raise ValueError("Tushare分钟数据含无效数值")
        for field in ("open", "close", "high", "low"):
            values[field] = round(values[field], 6)
        if (
            values["vol"] == 0
            and values["amount"] == 0
            and any(
                values[field] <= 0
                for field in ("open", "close", "high", "low")
            )
        ):
            excluded_dates.add(timestamp[:8])
            continue
        if (
            min(values["open"], values["close"], values["low"]) <= 0
            or values["high"] < max(values["open"], values["close"])
            or values["low"] > min(values["open"], values["close"])
            or values["vol"] < 0
            or values["amount"] < 0
        ):
            raise ValueError("Tushare分钟OHLCV结构无效")
        item = (
            expected_code,
            timestamp[:8],
            str(row["trade_time"]),
            values["open"],
            values["high"],
            values["low"],
            values["close"],
            values["vol"],
            values["amount"],
        )
        existing = normalized.get(timestamp)
        if existing is not None and existing != item:
            raise ValueError("Tushare分钟数据存在冲突重复")
        normalized[timestamp] = item
    values = [
        normalized[key]
        for key in sorted(normalized)
        if normalized[key][1] not in excluded_dates
    ]
    if include_exclusions:
        return values, sorted(excluded_dates)
    return values


def _minute_database(path):
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("""
        CREATE TABLE IF NOT EXISTS bars (
          code TEXT NOT NULL,
          date TEXT NOT NULL,
          trade_time TEXT NOT NULL,
          open REAL NOT NULL,
          high REAL NOT NULL,
          low REAL NOT NULL,
          close REAL NOT NULL,
          volume REAL NOT NULL,
          amount REAL NOT NULL,
          PRIMARY KEY (code, trade_time)
        )
    """)
    connection.execute("""
        CREATE INDEX IF NOT EXISTS bars_date_code
        ON bars(date, code, trade_time)
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS completed (
          code TEXT PRIMARY KEY,
          start_date TEXT NOT NULL,
          end_date TEXT NOT NULL,
          rows INTEGER NOT NULL
        )
    """)
    connection.execute("""
        CREATE TABLE IF NOT EXISTS exclusions (
          code TEXT NOT NULL,
          date TEXT NOT NULL,
          reason TEXT NOT NULL,
          PRIMARY KEY (code, date)
        )
    """)
    return connection


def _preclose_map(work, dates, codes):
    daily = read_gzip_json(work / "daily.json.gz")
    allowed_dates = set(dates)
    allowed_codes = set(codes)
    return {
        (row["date"], row["code"]): _number(row.get("preClose"))
        for row in daily
        if row.get("date") in allowed_dates
        and row.get("code") in allowed_codes
    }


def _complete_minute_day(rows):
    if len(rows) < 45:
        return False
    first = re.sub(r"\D", "", rows[0][2])[-6:]
    last = re.sub(r"\D", "", rows[-1][2])[-6:]
    return first <= "093500" and last >= "150000"


def export_minutes(args):
    manifest = load_manifest(args.manifest)
    if args.dry_run:
        print(json.dumps({
            "ok": True,
            "dates": len(manifest),
            "maximumCodes": max(len(row["codes"]) for row in manifest),
        }))
        return
    work = safe_directory(args.work_dir)
    output = safe_directory(args.output_dir)
    requested_by_code = {}
    for row in manifest:
        for code in row["codes"]:
            requested_by_code.setdefault(code, set()).add(row["date"])
    codes = sorted(requested_by_code)
    dates = [row["date"] for row in manifest]
    connection = _minute_database(work / "tushare-minute.sqlite3")
    client = TushareClient(max_per_min=args.max_per_min)
    downloaded = 0
    cached = 0
    try:
        for index, code in enumerate(codes, 1):
            completed = connection.execute(
                "SELECT start_date, end_date FROM completed WHERE code = ?",
                (code,),
            ).fetchone()
            if completed == (dates[0], dates[-1]):
                cached += 1
            else:
                rows = client.rows(
                    "stk_mins",
                    {
                        "ts_code": to_tushare_code(code),
                        "freq": "5min",
                        "start_date":
                            f"{dates[0][:4]}-{dates[0][4:6]}-"
                            f"{dates[0][6:]} 09:30:00",
                        "end_date":
                            f"{dates[-1][:4]}-{dates[-1][4:6]}-"
                            f"{dates[-1][6:]} 15:00:00",
                    },
                    MINUTE_FIELDS,
                )
                if len(rows) >= 8000:
                    raise ValueError(
                        f"Tushare分钟响应触及8000行上限: {code}"
                    )
                normalized, excluded_dates = _minute_rows(
                    rows,
                    code,
                    requested_by_code[code],
                    include_exclusions=True,
                )
                with connection:
                    connection.execute(
                        "DELETE FROM bars WHERE code = ?",
                        (code,),
                    )
                    connection.execute(
                        "DELETE FROM exclusions WHERE code = ?",
                        (code,),
                    )
                    connection.executemany("""
                        INSERT INTO bars (
                          code,date,trade_time,open,high,low,close,volume,amount
                        ) VALUES (?,?,?,?,?,?,?,?,?)
                    """, normalized)
                    connection.executemany("""
                        INSERT INTO exclusions(code,date,reason)
                        VALUES (?,?,'ZERO_OHLCV_SUSPENSION')
                    """, [
                        (code, date)
                        for date in excluded_dates
                    ])
                    connection.execute("""
                        INSERT INTO completed(code,start_date,end_date,rows)
                        VALUES (?,?,?,?)
                        ON CONFLICT(code) DO UPDATE SET
                          start_date=excluded.start_date,
                          end_date=excluded.end_date,
                          rows=excluded.rows
                    """, (code, dates[0], dates[-1], len(normalized)))
                downloaded += 1
            if index == 1 or index % 25 == 0 or index == len(codes):
                print(json.dumps({
                    "stage": "MINUTE_CODE",
                    "progress": index,
                    "total": len(codes),
                    "downloaded": downloaded,
                    "cached": cached,
                }), flush=True)

        preclose = _preclose_map(work, dates, codes)
        coverage_rows = []
        total_bars = 0
        for index, row in enumerate(manifest, 1):
            date = row["date"]
            allowed = set(row["codes"])
            grouped = {code: [] for code in row["codes"]}
            cursor = connection.execute("""
                SELECT code,date,trade_time,open,high,low,close,volume,amount
                FROM bars WHERE date = ? ORDER BY code,trade_time
            """, (date,))
            for value in cursor:
                if value[0] in allowed:
                    grouped[value[0]].append(value)
            complete = 0
            payload = {"date": date, "codes": {}}
            for code in row["codes"]:
                values = grouped[code]
                if not _complete_minute_day(values):
                    payload["codes"][code] = []
                    continue
                complete += 1
                payload["codes"][code] = [{
                    "date": re.sub(r"\D", "", value[2]),
                    "code": code,
                    "open": value[3],
                    "high": value[4],
                    "low": value[5],
                    "close": value[6],
                    "volume": value[7],
                    "amount": value[8],
                    "pre_close": preclose.get((date, code)),
                } for value in values]
                total_bars += len(values)
            coverage = complete / len(row["codes"])
            coverage_rows.append({
                "date": date,
                "requestedCodes": len(row["codes"]),
                "completeCodes": complete,
                "coverage": round(coverage, 6),
            })
            if coverage < args.minimum_coverage:
                raise ValueError(
                    f"Tushare分钟日覆盖率不足: {date} "
                    f"{complete}/{len(row['codes'])}"
                )
            write_gzip_json(output / f"{date}.json.gz", payload)
            if index == 1 or index % 10 == 0 or index == len(manifest):
                print(json.dumps({
                    "stage": "MINUTE_DAY",
                    "progress": index,
                    "total": len(manifest),
                    **coverage_rows[-1],
                }), flush=True)
        report = {
            "schemaVersion": "tushare-minute-export.v1",
            "frequency": "5min",
            "dates": len(manifest),
            "codes": len(codes),
            "downloadedCodes": downloaded,
            "cachedCodes": cached,
            "bars": total_bars,
            "sourceQualityExcludedCodeDays": int(
                connection.execute(
                    "SELECT count(*) FROM exclusions"
                ).fetchone()[0]
            ),
            "minimumCoverage": min(
                row["coverage"] for row in coverage_rows
            ),
            "coverage": coverage_rows,
        }
        report_path = work / "tushare-minute-report.json"
        temporary = report_path.with_suffix(".json.part")
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
        os.chmod(temporary, 0o600)
        os.replace(temporary, report_path)
        print(json.dumps({
            "stage": "MINUTES_DONE",
            **{
                key: value
                for key, value in report.items()
                if key != "coverage"
            },
        }), flush=True)
    finally:
        connection.close()


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--stage",
        required=True,
        choices=("metadata", "minutes"),
    )
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--from", dest="start")
    parser.add_argument("--to", dest="end")
    parser.add_argument("--manifest")
    parser.add_argument("--output-dir")
    parser.add_argument("--max-per-min", type=int, default=90)
    parser.add_argument("--minimum-coverage", type=float, default=0.85)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if not 1 <= args.max_per_min <= 120:
        parser.error("--max-per-min 必须在1到120之间")
    if not 0.85 <= args.minimum_coverage <= 1:
        parser.error("--minimum-coverage 必须在0.85到1之间")
    if args.stage == "metadata":
        if not args.start or not args.end:
            parser.error("metadata阶段需要--from和--to")
        args.start = compact_date(args.start)
        args.end = compact_date(args.end)
        if args.start >= args.end:
            parser.error("Tushare元数据日期范围无效")
    else:
        if not args.manifest:
            parser.error("minutes阶段需要--manifest")
        if not args.dry_run and not args.output_dir:
            parser.error("minutes阶段需要--output-dir")
    return args


def main():
    args = parse_args()
    if args.stage == "metadata":
        if args.dry_run:
            print(json.dumps({
                "ok": True,
                "from": args.start,
                "to": args.end,
                "maxPerMinute": args.max_per_min,
            }))
            return
        export_metadata(args)
    else:
        export_minutes(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
