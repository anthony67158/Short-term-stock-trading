"""Export verified OSS market shards into the causal replay workspace."""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path

from model_lib import _oss_bucket
from opportunity_market_archive import (
    MANIFEST_KEY,
    MANIFEST_SCHEMA_VERSION,
    SCHEMA_VERSION,
)
from opportunity_sector_archive import (
    SCHEMA_VERSION as SECTOR_SCHEMA_VERSION,
    load_sector_membership,
)


def _write_gzip(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = target.with_suffix(target.suffix + ".part")
    raw = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    with open(temporary, "wb") as output:
        os.chmod(temporary, 0o600)
        with gzip.GzipFile(
            fileobj=output,
            mode="wb",
            compresslevel=6,
            mtime=0,
        ) as handle:
            handle.write(raw)
    os.replace(temporary, target)


def _read_gzip(path):
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def _manifest(bucket):
    value = json.loads(
        bucket.get_object(MANIFEST_KEY).read().decode("utf-8")
    )
    if value.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        raise ValueError("市场归档manifest版本无效")
    return value


def _artifact(bucket, entry):
    encoded = bucket.get_object(entry["key"]).read()
    if hashlib.sha256(encoded).hexdigest() != entry.get("sha256"):
        raise ValueError("市场归档分片摘要无效")
    value = json.loads(gzip.decompress(encoded).decode("utf-8"))
    if (
        value.get("schemaVersion") != SCHEMA_VERSION
        or value.get("date") != entry.get("date")
    ):
        raise ValueError("市场归档分片内容无效")
    return value


def export_market_archive(
    *,
    work_dir,
    from_date,
    to_date,
    max_per_min=120,
):
    work = Path(work_dir).expanduser().resolve()
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    minute_dir = work / "minutes"
    minute_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    bucket = _oss_bucket()
    if bucket is None:
        raise RuntimeError("市场归档OSS未配置")
    manifest = _manifest(bucket)
    entries = [
        row
        for row in manifest.get("dates", [])
        if from_date <= str(row.get("date") or "") <= to_date
    ]
    if len(entries) < 60:
        raise ValueError("可用市场归档少于60个交易日")
    report_path = work / "archive-export-report.json"
    required_files = [
        work / "daily.json.gz",
        work / "funds.json.gz",
        work / "sector-membership.json.gz",
        work / "archive-replay-manifest.json",
        *[
            minute_dir / f"{entry['date']}.json.gz"
            for entry in entries
        ],
    ]
    if report_path.is_file() and all(path.is_file() for path in required_files):
        with open(report_path, encoding="utf-8") as handle:
            cached = json.load(handle)
        if (
            cached.get("manifestActivatedAt") == manifest.get("activatedAt")
            and cached.get("from") == entries[0]["date"]
            and cached.get("to") == entries[-1]["date"]
        ):
            return {**cached, "cached": True}

    daily = []
    funds = []
    replay_manifest = {
        "schemaVersion": "opportunity-archive-replay.v1",
        "dates": [],
    }
    for index, entry in enumerate(entries, 1):
        value = _artifact(bucket, entry)
        daily.extend(value["daily"])
        funds.extend(value["funds"])
        minutes = {
            "date": value["date"],
            "codes": value["minutes"],
        }
        _write_gzip(
            minute_dir / f"{value['date']}.json.gz",
            minutes,
        )
        replay_manifest["dates"].append({
            "date": value["date"],
            "codes": sorted(value["minutes"]),
        })
        if index == 1 or index % 10 == 0 or index == len(entries):
            print(json.dumps({
                "stage": "ARCHIVE_DAY",
                "progress": index,
                "total": len(entries),
                "date": value["date"],
            }), flush=True)

    prehistory_dates = []
    cache_dir = work / "prehistory-days"
    cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    cached_prehistory = sorted(cache_dir.glob("*.json.gz"))
    for path in cached_prehistory:
        date = path.name[:8]
        if from_date <= date < entries[0]["date"]:
            value = _read_gzip(path)
            daily.extend(value.get("daily") or [])
            funds.extend(value.get("funds") or [])
            prehistory_dates.append(date)

    memberships = load_sector_membership(bucket)
    if not memberships:
        raise ValueError("OSS缺少行业成员档案")
    sector_artifact = {
        "schemaVersion": SECTOR_SCHEMA_VERSION,
        "source": "OSS_SECTOR_MEMBERSHIP",
        "summary": {
            "memberships": len(memberships),
            "codes": len({item["code"] for item in memberships}),
            "sectors": len({
                item["sectorCode"]
                for item in memberships
            }),
        },
        "memberships": memberships,
    }
    _write_gzip(
        work / "sector-membership.json.gz",
        sector_artifact,
    )
    _write_gzip(work / "daily.json.gz", daily)
    _write_gzip(work / "funds.json.gz", funds)
    with open(
        work / "archive-replay-manifest.json",
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(
            replay_manifest,
            handle,
            ensure_ascii=False,
            indent=2,
        )
    report = {
        "manifestActivatedAt": manifest.get("activatedAt"),
        "archiveDates": len(entries),
        "prehistoryDates": len(prehistory_dates),
        "dailyRows": len(daily),
        "fundRows": len(funds),
        "sectorMemberships":
            sector_artifact["summary"]["memberships"],
        "from": entries[0]["date"],
        "to": entries[-1]["date"],
    }
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    return {**report, "cached": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--from", dest="from_date", required=True)
    parser.add_argument("--to", dest="to_date", required=True)
    parser.add_argument("--max-per-min", type=int, default=120)
    args = parser.parse_args()
    print(json.dumps(
        export_market_archive(
            work_dir=args.work_dir,
            from_date=args.from_date,
            to_date=args.to_date,
            max_per_min=args.max_per_min,
        ),
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    main()
