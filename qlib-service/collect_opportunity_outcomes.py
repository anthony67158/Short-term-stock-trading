"""Collect immutable opportunity outcomes from OSS for offline training."""

import argparse
import datetime as dt
import json
import os
from concurrent.futures import ThreadPoolExecutor

from model_lib import _oss_bucket
from opportunity_dataset import build_opportunity_dataset_file


OUTCOME_PREFIX = "market/opportunity-radar/v1/outcomes/"


def _date(value):
    try:
        return dt.date.fromisoformat(str(value))
    except ValueError as error:
        raise ValueError("机会结果日期无效") from error


def _dates(from_date, to_date):
    start = _date(from_date)
    end = _date(to_date)
    if start > end:
        raise ValueError("机会结果日期范围无效")
    days = []
    current = end
    while current >= start and len(days) < 366:
        days.append(current.isoformat())
        current -= dt.timedelta(days=1)
    return days


def _list_keys(bucket, prefix):
    keys = []
    marker = ""
    while True:
        result = bucket.list_objects(
            prefix=prefix,
            marker=marker,
            max_keys=1000,
        )
        keys.extend(
            item.key
            for item in (getattr(result, "object_list", None) or [])
            if str(item.key).endswith(".json")
        )
        if not getattr(result, "is_truncated", False):
            break
        marker = str(getattr(result, "next_marker", "") or "")
        if not marker:
            raise RuntimeError("机会结果OSS分页游标缺失")
    return keys


def _read_json(bucket, key):
    try:
        payload = bucket.get_object(key).read()
        value = json.loads(payload.decode("utf-8"))
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def collect_opportunity_outcomes(
    bucket,
    *,
    from_date,
    to_date,
    limit=10000,
    workers=12,
):
    maximum = max(1, min(10000, int(limit)))
    keys = []
    for day in _dates(from_date, to_date):
        if len(keys) >= maximum:
            break
        keys.extend(_list_keys(
            bucket,
            f"{OUTCOME_PREFIX}{day}/",
        )[: maximum - len(keys)])
    with ThreadPoolExecutor(
        max_workers=max(1, min(24, int(workers))),
    ) as executor:
        values = list(executor.map(
            lambda key: _read_json(bucket, key),
            keys,
        ))
    return sorted(
        (
            value
            for value in values
            if value
            and value.get("maturity") == "MATURED"
            and str(value.get("decisionId") or "").startswith("formula:")
        ),
        key=lambda item: str(item.get("decisionId") or ""),
    )


def collect_to_files(
    bucket,
    *,
    from_date,
    to_date,
    export_path,
    dataset_path,
):
    outcomes = collect_opportunity_outcomes(
        bucket,
        from_date=from_date,
        to_date=to_date,
    )
    export = {
        "schemaVersion": "opportunity-outcome-export.v1",
        "exportedAt": int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000),
        "range": {
            "from": str(from_date),
            "to": str(to_date),
        },
        "summary": {
            "collected": len(outcomes),
        },
        "outcomes": outcomes,
    }
    export_path = os.path.abspath(export_path)
    dataset_path = os.path.abspath(dataset_path)
    os.makedirs(os.path.dirname(export_path), exist_ok=True)
    os.makedirs(os.path.dirname(dataset_path), exist_ok=True)
    temporary = export_path + ".part"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(export, handle, ensure_ascii=False, indent=2)
    os.replace(temporary, export_path)
    dataset = build_opportunity_dataset_file(
        export_path,
        dataset_path,
    )
    return {
        "from": str(from_date),
        "to": str(to_date),
        "collected": len(outcomes),
        "dataset": dataset,
    }


def main():
    parser = argparse.ArgumentParser(
        description="从OSS收集机会雷达成熟结果",
    )
    parser.add_argument("--from", dest="from_date")
    parser.add_argument("--to", dest="to_date")
    parser.add_argument(
        "--export",
        default="opportunity-outcomes.json",
    )
    parser.add_argument(
        "--dataset",
        default="opportunity-dataset.npz",
    )
    args = parser.parse_args()
    today = dt.datetime.now(
        dt.timezone(dt.timedelta(hours=8)),
    ).date()
    from_date = args.from_date or (
        today - dt.timedelta(days=180)
    ).isoformat()
    to_date = args.to_date or today.isoformat()
    bucket = _oss_bucket()
    if bucket is None:
        raise RuntimeError("机会结果OSS未配置")
    report = collect_to_files(
        bucket,
        from_date=from_date,
        to_date=to_date,
        export_path=args.export,
        dataset_path=args.dataset,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
