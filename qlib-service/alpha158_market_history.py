"""Compact immutable main-board daily bars for Alpha158 retraining."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import re
import time

from model_lib import _oss_bucket


SHARD_SCHEMA_VERSION = "alpha158-daily-shard.v1"
MANIFEST_SCHEMA_VERSION = "alpha158-daily-history-manifest.v1"
PREFIX = "opportunitymodel/alpha158/market-data/v1"
MANIFEST_KEY = f"{PREFIX}/manifest.json"
MAIN_BOARD_PATTERN = re.compile(
    r"^(?:000|001|002|003|600|601|603|605)\d{3}$"
)
DATE_PATTERN = re.compile(r"^\d{8}$")


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _date(value):
    compact = str(value or "").replace("-", "")
    return compact if DATE_PATTERN.fullmatch(compact) else None


def _normalize_row(value, date):
    code = str((value or {}).get("code") or "")
    if (
        not MAIN_BOARD_PATTERN.fullmatch(code)
        or _date((value or {}).get("date")) != date
    ):
        return None
    prices = {
        name: _number((value or {}).get(name))
        for name in ("open", "high", "low", "close")
    }
    if (
        any(price is None or price <= 0 for price in prices.values())
        or prices["high"] < max(prices["open"], prices["close"])
        or prices["low"] > min(prices["open"], prices["close"])
    ):
        return None
    volume = _number(value.get("volume") or value.get("vol"))
    amount = _number(value.get("amount") or value.get("money"))
    pre_close = _number(
        value.get("preClose") or value.get("pre_close")
    )
    turnover = _number(
        value.get("turnover") or value.get("turnover_rate")
    )
    if (
        volume is None
        or volume < 0
        or amount is None
        or amount < 0
        or pre_close is None
        or pre_close <= 0
    ):
        return None
    return {
        "date": date,
        "code": code,
        "name": str(value.get("name") or code)[:40],
        **prices,
        "preClose": pre_close,
        "volume": volume,
        "amount": amount,
        "turnover": turnover,
        "isSt": bool(value.get("isSt") or value.get("is_st")),
    }


def build_daily_shard(date, rows, *, minimum_rows=500):
    normalized_date = _date(date)
    if not normalized_date:
        raise ValueError("Alpha158日线日期无效")
    unique = {}
    for row in rows if isinstance(rows, list) else []:
        value = _normalize_row(row, normalized_date)
        if value is not None:
            unique[value["code"]] = value
    values = [unique[code] for code in sorted(unique)]
    if len(values) < int(minimum_rows):
        raise ValueError("Alpha158主板日线覆盖不足")
    return {
        "schemaVersion": SHARD_SCHEMA_VERSION,
        "date": normalized_date,
        "rows": values,
    }


def _encode(value):
    raw = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return gzip.compress(raw, compresslevel=9, mtime=0)


def _json(bucket, key):
    try:
        return json.loads(bucket.get_object(key).read().decode("utf-8"))
    except Exception as error:
        if (
            isinstance(error, KeyError)
            or getattr(error, "status", None) == 404
            or getattr(error, "code", None) == "NoSuchKey"
        ):
            return None
        raise


def publish_alpha158_daily_shards(
    bucket,
    rows,
    *,
    activated_at=None,
    minimum_rows=500,
    maximum_days=800,
):
    grouped = {}
    for row in rows if isinstance(rows, list) else []:
        date = _date((row or {}).get("date"))
        if date:
            grouped.setdefault(date, []).append(row)
    current = _json(bucket, MANIFEST_KEY)
    if (
        current is not None
        and current.get("schemaVersion") != MANIFEST_SCHEMA_VERSION
    ):
        raise ValueError("Alpha158日线清单版本无效")
    entries = {
        str(row.get("date")): row
        for row in (current or {}).get("dates", [])
        if isinstance(row, dict)
        and DATE_PATTERN.fullmatch(str(row.get("date") or ""))
    }
    published = []
    for date in sorted(grouped):
        shard = build_daily_shard(
            date,
            grouped[date],
            minimum_rows=minimum_rows,
        )
        encoded = _encode(shard)
        digest = hashlib.sha256(encoded).hexdigest()
        key = f"{PREFIX}/dates/{date}-{digest[:16]}.json.gz"
        try:
            bucket.put_object(
                key,
                encoded,
                headers={"x-oss-forbid-overwrite": "true"},
            )
        except Exception as error:
            if getattr(error, "status", None) != 409:
                raise
        entry = {
            "date": date,
            "key": key,
            "sha256": digest,
            "size": len(encoded),
            "rows": len(shard["rows"]),
        }
        entries[date] = entry
        published.append(entry)
    retained_dates = sorted(entries)[-max(120, int(maximum_days)):]
    retained = [entries[date] for date in retained_dates]
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "activatedAt": int(activated_at or time.time() * 1000),
        "dateRange": {
            "from": retained_dates[0] if retained_dates else None,
            "to": retained_dates[-1] if retained_dates else None,
        },
        "summary": {
            "dates": len(retained),
            "rows": sum(int(row["rows"]) for row in retained),
        },
        "dates": retained,
    }
    bucket.put_object(
        MANIFEST_KEY,
        json.dumps(
            manifest,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8"),
        headers={"Cache-Control": "no-cache"},
    )
    return {
        "manifest": manifest,
        "published": published,
    }


def append_alpha158_market_day(
    bucket,
    artifact,
    *,
    minimum_rows=500,
):
    if not isinstance(artifact, dict):
        raise ValueError("市场日归档无效")
    return publish_alpha158_daily_shards(
        bucket,
        artifact.get("daily") or [],
        minimum_rows=minimum_rows,
    )


def export_alpha158_daily_history(
    bucket,
    output_path,
    *,
    minimum_days=120,
):
    manifest = _json(bucket, MANIFEST_KEY)
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != MANIFEST_SCHEMA_VERSION
    ):
        raise ValueError("Alpha158日线清单不存在或版本无效")
    entries = manifest.get("dates") or []
    if len(entries) < int(minimum_days):
        raise ValueError("Alpha158日线历史交易日不足")
    rows = []
    for entry in entries:
        encoded = bucket.get_object(entry["key"]).read()
        if hashlib.sha256(encoded).hexdigest() != entry.get("sha256"):
            raise ValueError("Alpha158日线分片摘要不匹配")
        shard = json.loads(gzip.decompress(encoded).decode("utf-8"))
        if (
            shard.get("schemaVersion") != SHARD_SCHEMA_VERSION
            or shard.get("date") != entry.get("date")
        ):
            raise ValueError("Alpha158日线分片内容无效")
        rows.extend(shard.get("rows") or [])
    output = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    temporary = output + ".part"
    with gzip.open(temporary, "wt", encoding="utf-8") as handle:
        json.dump(
            rows,
            handle,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
    os.replace(temporary, output)
    return {
        "from": entries[0]["date"],
        "to": entries[-1]["date"],
        "dates": len(entries),
        "rows": len(rows),
        "output": output,
    }


def _read_rows(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, list):
        raise ValueError("Alpha158日线种子必须是数组")
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed")
    parser.add_argument("--output")
    parser.add_argument("--minimum-days", type=int, default=120)
    args = parser.parse_args()
    if bool(args.seed) == bool(args.output):
        raise ValueError("必须且只能指定--seed或--output")
    bucket = _oss_bucket()
    if bucket is None:
        raise RuntimeError("Alpha158日线OSS未配置")
    result = (
        publish_alpha158_daily_shards(
            bucket,
            _read_rows(args.seed),
        )
        if args.seed
        else export_alpha158_daily_history(
            bucket,
            args.output,
            minimum_days=args.minimum_days,
        )
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
