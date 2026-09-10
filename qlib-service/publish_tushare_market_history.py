"""Publish validated local Tushare replay files as immutable OSS day shards."""

import argparse
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


def local_market_artifacts(work_dir, *, from_date=None, to_date=None):
    root = Path(work_dir).expanduser().resolve()
    metadata = root / "tushare-metadata" / "days"
    minutes = root / "minutes"
    if not metadata.is_dir() or not minutes.is_dir():
        raise ValueError("Tushare历史工作目录不完整")
    artifacts = []
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
        codes = minute.get("codes") or {}
        artifacts.append(build_market_day_artifact(
            date=date,
            daily=day.get("daily"),
            funds=day.get("funds"),
            minutes=minute,
            source="TUSHARE_CAUSAL_REPLAY",
            universe_source_date=date,
            requested_codes=len(codes),
        ))
    if not artifacts:
        raise ValueError("没有可发布的Tushare历史分片")
    return artifacts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--from", dest="from_date")
    parser.add_argument("--to", dest="to_date")
    args = parser.parse_args()
    result = publish_market_days(
        bucket(),
        local_market_artifacts(
            args.work_dir,
            from_date=args.from_date,
            to_date=args.to_date,
        ),
    )
    print(json.dumps({
        "publishedDates": len(result["published"]),
        "totalDates": result["manifest"]["summary"]["dates"],
        "minuteBars": result["manifest"]["summary"]["minuteBars"],
        "from": result["manifest"]["dateRange"]["from"],
        "to": result["manifest"]["dateRange"]["to"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
