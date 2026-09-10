"""Append the latest completed Tushare market day to the V3 OSS archive."""

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from tushare_export_history import (  # noqa: E402
    _complete_minute_day,
    _minute_rows,
    normalize_daily_rows,
    normalize_fund_rows,
    to_tushare_code,
)
from opportunity_market_archive import (  # noqa: E402
    build_market_day_artifact,
    load_market_day,
    publish_market_days,
)
from tushare_client import TushareClient  # noqa: E402
from upload_model import bucket  # noqa: E402


def stable_hash(value):
    result = 2166136261
    for character in str(value):
        result ^= ord(character)
        result = (result * 16777619) & 0xFFFFFFFF
    return result


def select_causal_universe(rows, trade_date, *, limit=1000, liquid_share=0.8):
    candidates = [
        row for row in rows
        if re.fullmatch(r"\d{6}", str(row.get("code") or ""))
        and not row.get("isSt")
        and not re.search(r"ST|退", str(row.get("name") or ""), re.IGNORECASE)
        and float(row.get("close") or 0) > 0
        and float(row.get("amount") or 0) >= 30_000_000
        and float(row.get("turnover") or 0) >= 0.3
    ]
    normalized_limit = max(100, int(limit or 1000))
    liquid_limit = max(1, min(normalized_limit, int(normalized_limit * liquid_share)))
    liquid = sorted(
        candidates,
        key=lambda row: (-float(row["amount"]), str(row["code"])),
    )[:liquid_limit]
    selected = {str(row["code"]) for row in liquid}
    exploration = sorted(
        (row for row in candidates if str(row["code"]) not in selected),
        key=lambda row: (stable_hash(f"{trade_date}:{row['code']}"), str(row["code"])),
    )
    for row in exploration:
        if len(selected) >= normalized_limit:
            break
        selected.add(str(row["code"]))
    return sorted(selected)


def completed_trade_dates(calendar, *, now=None):
    now = now or dt.datetime.now(ZoneInfo("Asia/Shanghai"))
    latest = (now.date() - dt.timedelta(days=1)).strftime("%Y%m%d")
    result = sorted({
        str(row.get("cal_date") or "")
        for row in calendar
        if int(row.get("is_open") or 0) == 1
        and str(row.get("cal_date") or "") <= latest
    })
    if len(result) < 2:
        raise ValueError("Tushare近期完整交易日不足2日")
    return result


def security_names(client):
    values = {}
    for status in ("L", "D", "P"):
        for row in client.stock_basic(
            list_status=status,
            fields="ts_code,symbol,name,list_date,delist_date",
        ):
            code = str(row.get("symbol") or "")
            if re.fullmatch(r"\d{6}", code):
                values[code] = str(row.get("name") or code)
    if len(values) < 800:
        raise ValueError("Tushare证券主表覆盖不足")
    return values


def day_metadata(client, date, names):
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
    return (
        normalize_daily_rows(daily, basic, names),
        normalize_fund_rows(funds),
    )


def minute_payload(client, date, codes):
    complete = {}
    excluded = []
    for index, code in enumerate(codes, 1):
        rows = client.rows(
            "stk_mins",
            {
                "ts_code": to_tushare_code(code),
                "freq": "5min",
                "start_date": f"{date[:4]}-{date[4:6]}-{date[6:]} 09:30:00",
                "end_date": f"{date[:4]}-{date[4:6]}-{date[6:]} 15:00:00",
            },
            "ts_code,trade_time,open,close,high,low,vol,amount",
        )
        if len(rows) >= 8000:
            raise ValueError(f"Tushare分钟响应触及8000行上限: {code}")
        normalized, zero_dates = _minute_rows(
            rows,
            code,
            {date},
            include_exclusions=True,
        )
        if zero_dates:
            excluded.append(code)
        if _complete_minute_day(normalized):
            complete[code] = [{
                "date": re.sub(r"\D", "", value[2]),
                "code": code,
                "open": value[3],
                "high": value[4],
                "low": value[5],
                "close": value[6],
                "volume": value[7],
                "amount": value[8],
                "pre_close": None,
            } for value in normalized]
        if index == 1 or index % 50 == 0 or index == len(codes):
            print(json.dumps({
                "stage": "MINUTE_CODE",
                "progress": index,
                "total": len(codes),
                "complete": len(complete),
                "excluded": len(excluded),
            }), flush=True)
    coverage = len(complete) / len(codes)
    if coverage < 0.85:
        raise ValueError(
            f"Tushare分钟日覆盖率不足: {date} {len(complete)}/{len(codes)}"
        )
    return {"date": date, "codes": complete}, excluded


def archive_latest(*, target_date=None, max_per_min=120, universe_size=1000):
    client = TushareClient(max_per_min=max_per_min)
    end = dt.datetime.now(ZoneInfo("Asia/Shanghai")).date()
    start = end - dt.timedelta(days=30)
    dates = completed_trade_dates(client.trade_cal(
        start_date=start.strftime("%Y%m%d"),
        end_date=end.strftime("%Y%m%d"),
    ))
    target = str(target_date or dates[-1])
    if target not in dates:
        raise ValueError("指定日期不是近期已完成交易日")
    index = dates.index(target)
    if index < 1:
        raise ValueError("缺少目标日之前的交易日")
    previous = dates[index - 1]
    oss = bucket()
    existing = load_market_day(oss, target)
    if existing is not None:
        return {
            "status": "already_archived",
            "date": target,
            "summary": existing["summary"],
            "universe": existing["universe"],
        }
    names = security_names(client)
    previous_daily, _previous_funds = day_metadata(client, previous, names)
    daily, funds = day_metadata(client, target, names)
    universe = select_causal_universe(
        previous_daily,
        target,
        limit=universe_size,
    )
    if len(universe) < universe_size:
        raise ValueError(f"Tushare因果股票池不足: {len(universe)}/{universe_size}")
    minutes, excluded = minute_payload(client, target, universe)
    preclose = {row["code"]: row.get("preClose") for row in daily}
    for code, bars in minutes["codes"].items():
        for bar in bars:
            bar["pre_close"] = preclose.get(code)
    artifact = build_market_day_artifact(
        date=target,
        daily=daily,
        funds=funds,
        minutes=minutes,
        source="TUSHARE_DAILY_INCREMENT",
        universe_source_date=previous,
        requested_codes=len(universe),
    )
    published = publish_market_days(oss, [artifact])
    return {
        "status": "published",
        "date": target,
        "excludedCodeDays": len(excluded),
        "entry": published["published"][0],
        "manifestSummary": published["manifest"]["summary"],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date")
    parser.add_argument("--max-per-min", type=int, default=120)
    parser.add_argument("--universe-size", type=int, default=1000)
    parser.add_argument("--report", default="market-archive-report.json")
    args = parser.parse_args()
    if not 1 <= args.max_per_min <= 120:
        parser.error("--max-per-min 必须在1到120之间")
    if not 100 <= args.universe_size <= 2000:
        parser.error("--universe-size 必须在100到2000之间")
    report = archive_latest(
        target_date=args.date,
        max_per_min=args.max_per_min,
        universe_size=args.universe_size,
    )
    temporary = args.report + ".part"
    Path(temporary).write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(temporary, args.report)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
