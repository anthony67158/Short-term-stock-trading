#!/usr/bin/env python3
"""沪深主板 3-5 年历史人工回填采集器（Tushare，仅人工回填）。

================================================================
为什么单独一层而不是改 tushare_export_history.py：
  tushare_export_history.metadata 已经把「逐日 daily+daily_basic+moneyflow →
  归一化 → gzip 缓存 → 汇总 daily.json.gz/funds.json.gz」做好且被多处复用。
  本脚本只补它没有的两件事，且不改它的既有契约：
    1) 主板过滤：只保留 000/001/002/003/600/601/603/605，排除创业板/科创板/
       北交所/ST/退市，与训练侧主板口径一致。
    2) 跨年完整性校验：交易日历对齐、每日去重、覆盖率、缺失显式标记；不达标
       失败关闭，不静默补零、不伪装成功。

铁律对齐：
  - Tushare 只允许人工历史回填，绝不接入 daily-retrain 每日训练（本脚本不被
    任何工作流调用，仅手动执行）。
  - token 只经 tushare_client 从 env 读取，绝不落库/打印明文。

用法：
  set -a; source ./.env; set +a
  python3 scripts/backfill-mainboard-history.py \
      --from 20210101 --to 20260911 \
      --work-dir /tmp/mainboard-5y \
      --output /tmp/mainboard-5y/mainboard-history.json.gz \
      --report /tmp/mainboard-5y/mainboard-coverage.json
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
SERVICE_ROOT = ROOT / "qlib-service"
for candidate in (SCRIPTS, SERVICE_ROOT):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

# 复用成熟的归一化与缓存工具，避免重复实现 HTTP/字段口径。
from tushare_export_history import (  # noqa: E402
    compact_date,
    export_metadata,
    read_gzip_json,
    safe_directory,
    write_gzip_json,
)

DATE = re.compile(r"^\d{8}$")
CODE = re.compile(r"^\d{6}$")
# 沪深主板前缀（与训练侧主板口径一致）：排除创业板 300/301、科创板 688/689、
# 北交所 8/920/430。
MAIN_BOARD_PREFIXES = (
    "000", "001", "002", "003",
    "600", "601", "603", "605",
)


def is_main_board(code):
    """仅沪深主板 6 位代码返回 True。"""
    text = str(code or "")
    return bool(CODE.fullmatch(text)) and text[:3] in MAIN_BOARD_PREFIXES


def filter_main_board_daily(rows):
    """保留主板、非 ST、价格结构有效的日线行，按 (date, code) 去重。

    纯函数：输入归一化日线行列表，输出过滤+去重后的新列表，不改输入。
    冲突重复（同 date+code 但字段不同）失败关闭，避免脏数据静默进入训练。
    """
    seen = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        code = str(row.get("code") or "")
        if not is_main_board(code) or row.get("isSt"):
            continue
        date = str(row.get("date") or "")
        if not DATE.fullmatch(date):
            continue
        close = row.get("close")
        pre_close = row.get("preClose")
        if not isinstance(close, (int, float)) or not (close > 0):
            continue
        if pre_close is not None and not (pre_close > 0):
            continue
        key = (date, code)
        existing = seen.get(key)
        if existing is not None and existing != row:
            raise ValueError(f"主板日线重复冲突: {date} {code}")
        seen[key] = row
    return [seen[key] for key in sorted(seen)]


def filter_main_board_funds(rows):
    """保留主板资金流行，按 (date, code) 去重；冲突失败关闭。"""
    seen = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        code = str(row.get("code") or "")
        if not is_main_board(code):
            continue
        date = str(row.get("date") or "")
        if not DATE.fullmatch(date):
            continue
        key = (date, code)
        existing = seen.get(key)
        if existing is not None and existing != row:
            raise ValueError(f"主板资金流重复冲突: {date} {code}")
        seen[key] = row
    return [seen[key] for key in sorted(seen)]


def coverage_report(daily_rows, fund_rows, open_dates, *, minimum_coverage):
    """按交易日历核对主板日线/资金流覆盖情况，输出可追溯报告。

    纯函数：不做 IO。缺失显式列出，不静默补零。fundCoverageRatio 是资金流
    相对日线的对齐率，低于阈值只标记（资金流历史缺口常见），日线覆盖率是硬门槛。
    """
    open_set = {compact_date(d) for d in open_dates}
    daily_by_date = {}
    codes_by_date = {}
    for row in daily_rows:
        date = row["date"]
        daily_by_date[date] = daily_by_date.get(date, 0) + 1
        codes_by_date.setdefault(date, set()).add(row["code"])
    fund_pairs = {(row["date"], row["code"]) for row in fund_rows}

    covered_dates = sorted(d for d in daily_by_date if d in open_set)
    missing_dates = sorted(open_set - set(daily_by_date))
    unexpected_dates = sorted(set(daily_by_date) - open_set)

    total_daily = len(daily_rows)
    fund_aligned = sum(
        1
        for row in daily_rows
        if (row["date"], row["code"]) in fund_pairs
    )
    date_coverage = (
        len(covered_dates) / len(open_set) if open_set else 0.0
    )
    fund_coverage = (
        fund_aligned / total_daily if total_daily else 0.0
    )
    per_date_codes = [len(codes_by_date[d]) for d in covered_dates]
    return {
        "schemaVersion": "mainboard-history-coverage.v1",
        "tradingDays": len(open_set),
        "coveredDays": len(covered_dates),
        "dateCoverageRatio": round(date_coverage, 6),
        "missingDays": missing_dates,
        "unexpectedDays": unexpected_dates,
        "dailyRows": total_daily,
        "fundRows": len(fund_rows),
        "fundAlignedRows": fund_aligned,
        "fundCoverageRatio": round(fund_coverage, 6),
        "minCodesPerDay": min(per_date_codes) if per_date_codes else 0,
        "maxCodesPerDay": max(per_date_codes) if per_date_codes else 0,
        "medianCodesPerDay": (
            sorted(per_date_codes)[len(per_date_codes) // 2]
            if per_date_codes
            else 0
        ),
        "startDate": covered_dates[0] if covered_dates else None,
        "endDate": covered_dates[-1] if covered_dates else None,
        "passed": (
            not missing_dates
            and not unexpected_dates
            and date_coverage >= minimum_coverage
        ),
        "minimumCoverage": minimum_coverage,
    }


def _load_open_dates(work_dir, start, end):
    source = safe_directory(work_dir) / "tushare-metadata"
    calendar_path = source / f"calendar-{start}-{end}.json.gz"
    calendar = read_gzip_json(calendar_path)
    return sorted({
        compact_date(row.get("cal_date"))
        for row in calendar
        if int(float(row.get("is_open") or 0)) == 1
    })


def run(args):
    if args.dry_run:
        print(json.dumps({
            "ok": True,
            "from": args.start,
            "to": args.end,
            "workDir": str(safe_directory(args.work_dir)),
            "minimumCoverage": args.minimum_coverage,
        }, ensure_ascii=False))
        return
    work = safe_directory(args.work_dir)
    daily_path = work / "daily.json.gz"
    funds_path = work / "funds.json.gz"

    if args.reuse_cache and daily_path.is_file() and funds_path.is_file():
        print(json.dumps({"stage": "REUSE_CACHE"}, ensure_ascii=False))
    else:
        # 复用成熟采集：逐日 daily+daily_basic+moneyflow → 归一化 → 汇总。
        export_metadata(args)

    all_daily = read_gzip_json(daily_path)
    all_funds = read_gzip_json(funds_path)
    open_dates = _load_open_dates(args.work_dir, args.start, args.end)

    main_daily = filter_main_board_daily(all_daily)
    main_funds = filter_main_board_funds(all_funds)
    report = coverage_report(
        main_daily,
        main_funds,
        open_dates,
        minimum_coverage=args.minimum_coverage,
    )

    write_gzip_json(args.output, main_daily)
    fund_out = re.sub(r"\.json\.gz$", "", args.output) + "-funds.json.gz"
    write_gzip_json(fund_out, main_funds)
    with open(args.report, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)

    print(json.dumps({
        "stage": "MAINBOARD_DONE",
        "output": os.path.abspath(args.output),
        "funds": os.path.abspath(fund_out),
        "report": os.path.abspath(args.report),
        **{k: report[k] for k in (
            "tradingDays", "coveredDays", "dateCoverageRatio",
            "dailyRows", "fundRows", "fundCoverageRatio", "passed",
        )},
    }, ensure_ascii=False))
    if not report["passed"]:
        raise SystemExit(
            "主板历史完整性校验未通过：存在缺失/多余交易日或覆盖率不足"
        )


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="沪深主板 3-5 年历史人工回填采集器（Tushare）",
    )
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--from", dest="start", required=True)
    parser.add_argument("--to", dest="end", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--max-per-min", type=int, default=90)
    parser.add_argument("--minimum-coverage", type=float, default=0.99)
    parser.add_argument("--reuse-cache", action="store_true")
    parser.add_argument("--stage", default="metadata")
    parser.add_argument("--manifest", default=None)
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if not 1 <= args.max_per_min <= 120:
        parser.error("--max-per-min 必须在1到120之间")
    if not DATE.fullmatch(args.start) or not DATE.fullmatch(args.end):
        parser.error("--from/--to 必须为 YYYYMMDD")
    return args


def main(argv=None):
    run(parse_args(argv))


if __name__ == "__main__":
    main()
