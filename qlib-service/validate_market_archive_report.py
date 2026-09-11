"""Validate the market archive result before starting V3 training."""

import argparse
import datetime as dt
import json
from pathlib import Path
from zoneinfo import ZoneInfo


COMPLETE_STATUSES = {"published", "already_archived"}
MANUAL_SKIP_STATUS = "market_open_skipped"
SHANGHAI = ZoneInfo("Asia/Shanghai")
MIN_DAILY_ROWS = 800
MIN_FUND_ROWS = 500
MIN_REQUESTED_CODES = 1000
MIN_MINUTE_COVERAGE = 0.85


def _validated_now(now):
    current = now or dt.datetime.now(tz=SHANGHAI)
    if current.tzinfo is None:
        raise ValueError("市场归档校验时间必须包含时区")
    return current.astimezone(SHANGHAI)


def _validate_settled_date(date, now):
    trade_day = dt.datetime.strptime(date, "%Y%m%d").date()
    settled_at = dt.datetime.combine(
        trade_day,
        dt.time(hour=15, minute=10),
        tzinfo=SHANGHAI,
    )
    if now < settled_at:
        raise ValueError(f"市场归档交易日尚未完成收盘结算: {date}")


def _validate_artifact(artifact, date):
    if not isinstance(artifact, dict) or artifact.get("date") != date:
        raise ValueError(f"OSS缺少市场归档: {date}")
    summary = artifact.get("summary") or {}
    universe = artifact.get("universe") or {}
    daily_rows = int(summary.get("dailyRows") or 0)
    fund_rows = int(summary.get("fundRows") or 0)
    minute_codes = int(summary.get("minuteCodes") or 0)
    requested_codes = int(universe.get("requestedCodes") or 0)
    complete_codes = int(universe.get("completeCodes") or 0)
    coverage = float(universe.get("coverage") or 0)
    if daily_rows < MIN_DAILY_ROWS:
        raise ValueError(
            f"OSS市场归档日线不足: {daily_rows}/{MIN_DAILY_ROWS}"
        )
    if fund_rows < MIN_FUND_ROWS:
        raise ValueError(
            f"OSS市场归档资金流不足: {fund_rows}/{MIN_FUND_ROWS}"
        )
    if requested_codes < MIN_REQUESTED_CODES:
        raise ValueError(
            "OSS市场归档分钟线请求股票池不足: "
            f"{requested_codes}/{MIN_REQUESTED_CODES}"
        )
    if complete_codes != minute_codes:
        raise ValueError(
            "OSS市场归档分钟线统计不一致: "
            f"{complete_codes}/{minute_codes}"
        )
    measured_coverage = complete_codes / requested_codes
    if (
        coverage < MIN_MINUTE_COVERAGE
        or measured_coverage < MIN_MINUTE_COVERAGE
        or abs(coverage - measured_coverage) > 0.000001
    ):
        raise ValueError(
            "OSS市场归档分钟线覆盖不足: "
            f"{complete_codes}/{requested_codes}, "
            f"{coverage:.2%}"
        )


def validate_report(
    report,
    *,
    event_name,
    now=None,
    archive_loader=None,
):
    if not isinstance(report, dict):
        raise ValueError("市场归档报告格式无效")
    status = str(report.get("status") or "").strip()
    date = str(report.get("date") or "").strip()
    event = str(event_name or "").strip()
    current = _validated_now(now)
    if status in COMPLETE_STATUSES:
        if len(date) != 8 or not date.isdigit():
            raise ValueError("完整市场归档缺少有效交易日期")
        result = {
            "ready": True,
            "mode": "complete",
            "status": status,
            "date": date,
        }
    elif status == MANUAL_SKIP_STATUS and event == "workflow_dispatch":
        latest = str(report.get("latestArchiveDate") or "").strip()
        if len(latest) != 8 or not latest.isdigit():
            raise ValueError("盘中跳过归档但缺少最新完整归档日期")
        result = {
            "ready": True,
            "mode": "manual_market_open",
            "status": status,
            "date": latest,
        }
    elif event == "schedule":
        raise ValueError(
            "夜间定时训练未获得最新完整市场归档，已阻断决策模型训练"
        )
    else:
        raise ValueError(
            str(report.get("reason") or "市场归档未完成，已阻断决策模型训练")
        )
    _validate_settled_date(result["date"], current)
    if archive_loader is not None:
        _validate_artifact(archive_loader(result["date"]), result["date"])
        result["ossVerified"] = True
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    parser.add_argument("--event", required=True)
    parser.add_argument("--output")
    args = parser.parse_args()
    report = json.loads(
        Path(args.report).read_text(encoding="utf-8")
    )
    from model_lib import _oss_bucket
    from opportunity_market_archive import load_market_day

    bucket = _oss_bucket()
    if bucket is None:
        raise RuntimeError("市场归档OSS未配置")
    result = validate_report(
        report,
        event_name=args.event,
        now=dt.datetime.now(tz=SHANGHAI),
        archive_loader=lambda date: load_market_day(bucket, date),
    )
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(payload + "\n", encoding="utf-8")
    print(payload)


if __name__ == "__main__":
    main()
