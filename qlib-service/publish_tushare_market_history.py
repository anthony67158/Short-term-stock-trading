"""Publish validated local Tushare replay files as immutable OSS day shards."""

import argparse
from datetime import datetime, timedelta, timezone
import gzip
import json
from pathlib import Path

from opportunity_market_archive import (
    build_market_day_artifact,
    publish_market_days,
)
from upload_model import bucket


def read_gzip_json(path):
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def market_close_ms(date):
    beijing = timezone(timedelta(hours=8))
    closed_at = datetime.strptime(date, "%Y%m%d").replace(
        hour=16,
        tzinfo=beijing,
    )
    return int(closed_at.timestamp() * 1000)


def iter_local_market_artifacts(work_dir, *, from_date=None, to_date=None):
    root = Path(work_dir).expanduser().resolve()
    metadata = root / "tushare-metadata" / "days"
    minutes = root / "minutes"
    if not metadata.is_dir() or not minutes.is_dir():
        raise ValueError("Tushare历史工作目录不完整")
    metadata_dates = sorted(
        path.name[:8]
        for path in metadata.glob("*.json.gz")
        if path.name[:8].isdigit()
    )
    previous_dates = {
        date: metadata_dates[index - 1]
        for index, date in enumerate(metadata_dates)
        if index > 0
    }
    found = False
    for minute_path in sorted(minutes.glob("*.json.gz")):
        date = minute_path.name[:8]
        if from_date and date < from_date:
            continue
        if to_date and date > to_date:
            continue
        metadata_path = metadata / f"{date}.json.gz"
        if not metadata_path.is_file():
            raise ValueError(f"Tushare历史元数据缺失: {date}")
        day = read_gzip_json(metadata_path)
        minute = read_gzip_json(minute_path)
        if day.get("date") != date or minute.get("date") != date:
            raise ValueError(f"Tushare历史分片日期不一致: {date}")
        universe_source_date = previous_dates.get(date)
        if universe_source_date is None:
            raise ValueError(f"Tushare历史分片缺少前一交易日: {date}")
        codes = minute.get("codes") or {}
        found = True
        yield build_market_day_artifact(
            date=date,
            daily=day.get("daily"),
            funds=day.get("funds"),
            minutes=minute,
            source="TUSHARE_CAUSAL_REPLAY",
            universe_source_date=universe_source_date,
            requested_codes=len(codes),
            generated_at=market_close_ms(date),
        )
    if not found:
        raise ValueError("没有可发布的Tushare历史分片")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--from", dest="from_date")
    parser.add_argument("--to", dest="to_date")
    args = parser.parse_args()
    target = bucket()
    batch = []
    published = []
    manifest = None
    for artifact in iter_local_market_artifacts(
        args.work_dir,
        from_date=args.from_date,
        to_date=args.to_date,
    ):
        batch.append(artifact)
        if len(batch) < 4:
            continue
        result = publish_market_days(target, batch)
        published.extend(result["published"])
        manifest = result["manifest"]
        print(json.dumps({
            "stage": "MARKET_ARCHIVE",
            "publishedDates": len(published),
            "lastDate": published[-1]["date"],
        }, ensure_ascii=False), flush=True)
        batch = []
    if batch:
        result = publish_market_days(target, batch)
        published.extend(result["published"])
        manifest = result["manifest"]
    if manifest is None:
        raise ValueError("没有可发布的Tushare历史分片")
    print(json.dumps({
        "publishedDates": len(published),
        "totalDates": manifest["summary"]["dates"],
        "minuteBars": manifest["summary"]["minuteBars"],
        "from": manifest["dateRange"]["from"],
        "to": manifest["dateRange"]["to"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
