"""Immutable, checksummed market-data shards for reproducible V3 replay."""

from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
import math
import re
import time


SCHEMA_VERSION = "opportunity-market-day.v1"
MANIFEST_SCHEMA_VERSION = "opportunity-market-manifest.v1"
PREFIX = "opportunitymodel/market-data/v1"
MANIFEST_KEY = f"{PREFIX}/manifest.json"
DATE_PATTERN = re.compile(r"^\d{8}$")
CODE_PATTERN = re.compile(r"^\d{6}$")


def market_close_ms(date):
    date = _date(date)
    beijing = timezone(timedelta(hours=8))
    closed_at = datetime.strptime(date, "%Y%m%d").replace(
        hour=16,
        tzinfo=beijing,
    )
    return int(closed_at.timestamp() * 1000)


def _date(value):
    result = str(value or "")
    if not DATE_PATTERN.fullmatch(result):
        raise ValueError("市场数据交易日无效")
    return result


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _rows(values, date, *, name):
    if not isinstance(values, list):
        raise ValueError(f"{name}必须是数组")
    unique = {}
    for value in values:
        if not isinstance(value, dict):
            raise ValueError(f"{name}行结构无效")
        code = str(value.get("code") or "")
        if not CODE_PATTERN.fullmatch(code) or str(value.get("date") or "") != date:
            raise ValueError(f"{name}代码或日期无效")
        unique[code] = value
    return [unique[code] for code in sorted(unique)]


def _minutes(value, date):
    codes = value.get("codes") if isinstance(value, dict) else None
    if not isinstance(codes, dict):
        raise ValueError("分钟数据结构无效")
    normalized = {}
    total = 0
    for code in sorted(codes):
        if not CODE_PATTERN.fullmatch(str(code)):
            raise ValueError("分钟股票代码无效")
        bars = codes[code]
        if not isinstance(bars, list):
            raise ValueError("分钟股票数据必须是数组")
        if not bars:
            continue
        if not 45 <= len(bars) <= 60:
            raise ValueError(f"分钟交易日不完整: {date}/{code}")
        seen = set()
        clean = []
        for bar in bars:
            timestamp = re.sub(r"\D", "", str((bar or {}).get("date") or ""))
            if len(timestamp) != 14 or not timestamp.startswith(date):
                raise ValueError("分钟时间戳无效")
            if timestamp in seen:
                raise ValueError("分钟时间戳重复")
            seen.add(timestamp)
            if str(bar.get("code") or "") != code:
                raise ValueError("分钟代码与分组不一致")
            prices = [_number(bar.get(field)) for field in ("open", "high", "low", "close")]
            volume = _number(bar.get("volume"))
            amount = _number(bar.get("amount"))
            if (
                any(item is None or item <= 0 for item in prices)
                or prices[1] < max(prices[0], prices[3])
                or prices[2] > min(prices[0], prices[3])
                or volume is None or volume < 0
                or amount is None or amount < 0
            ):
                raise ValueError("分钟OHLCV无效")
            clean.append(bar)
        clean.sort(key=lambda item: re.sub(r"\D", "", str(item["date"])))
        normalized[code] = clean
        total += len(clean)
    if not normalized:
        raise ValueError("市场数据不含完整分钟行情")
    return normalized, total


def build_market_day_artifact(
    *,
    date,
    daily,
    funds,
    minutes,
    source="TUSHARE",
    universe_source_date=None,
    requested_codes=None,
    generated_at=None,
):
    date = _date(date)
    universe_source_date = _date(universe_source_date or date)
    if universe_source_date > date:
        raise ValueError("分钟股票池使用了未来日期")
    normalized_daily = _rows(daily, date, name="日线")
    normalized_funds = _rows(funds, date, name="资金流")
    normalized_minutes, minute_bars = _minutes(minutes, date)
    requested = int(requested_codes or len(normalized_minutes))
    if len(normalized_daily) < 800 or len(normalized_funds) < 500:
        raise ValueError("市场数据全市场覆盖不足")
    if requested < len(normalized_minutes):
        raise ValueError("分钟请求股票数小于实际股票数")
    coverage = len(normalized_minutes) / requested
    if coverage < 0.85:
        raise ValueError("分钟完整股票覆盖率不足85%")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "date": date,
        "generatedAt": int(generated_at or time.time() * 1000),
        "source": str(source or "TUSHARE")[:40],
        "universe": {
            "sourceDate": universe_source_date,
            "requestedCodes": requested,
            "completeCodes": len(normalized_minutes),
            "coverage": round(coverage, 6),
        },
        "summary": {
            "dailyRows": len(normalized_daily),
            "fundRows": len(normalized_funds),
            "minuteCodes": len(normalized_minutes),
            "minuteBars": minute_bars,
        },
        "daily": normalized_daily,
        "funds": normalized_funds,
        "minutes": normalized_minutes,
    }


def encode_market_day(artifact):
    raw = json.dumps(
        artifact,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
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


def _existing_bytes(bucket, key):
    try:
        return bucket.get_object(key).read()
    except Exception as error:
        if (
            isinstance(error, KeyError)
            or getattr(error, "status", None) == 404
            or getattr(error, "code", None) == "NoSuchKey"
        ):
            return None
        raise


def publish_market_days(bucket, artifacts, *, activated_at=None):
    current = _json(bucket, MANIFEST_KEY)
    if current is not None and current.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        raise ValueError("市场数据manifest版本无效")
    entries = {
        row["date"]: row
        for row in (current or {}).get("dates", [])
        if isinstance(row, dict) and DATE_PATTERN.fullmatch(str(row.get("date") or ""))
    }
    published = []
    for artifact in artifacts:
        if artifact.get("schemaVersion") != SCHEMA_VERSION:
            raise ValueError("市场数据分片版本无效")
        encoded = encode_market_day(artifact)
        digest = hashlib.sha256(encoded).hexdigest()
        date = _date(artifact.get("date"))
        key = f"{PREFIX}/dates/{date}-{digest[:16]}.json.gz"
        existing = _existing_bytes(bucket, key)
        if existing is None:
            bucket.put_object(key, encoded, headers={"x-oss-forbid-overwrite": "true"})
        elif hashlib.sha256(existing).hexdigest() != digest:
            raise ValueError("OSS同名市场数据摘要冲突")
        entry = {
            "date": date,
            "key": key,
            "sha256": digest,
            "size": len(encoded),
            "source": artifact.get("source"),
            "universe": artifact.get("universe"),
            "summary": artifact.get("summary"),
        }
        entries[date] = entry
        published.append(entry)
    dates = [entries[key] for key in sorted(entries)]
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "activatedAt": int(activated_at or time.time() * 1000),
        "dateRange": {
            "from": dates[0]["date"] if dates else None,
            "to": dates[-1]["date"] if dates else None,
        },
        "summary": {
            "dates": len(dates),
            "minuteBars": sum(
                int((row.get("summary") or {}).get("minuteBars") or 0)
                for row in dates
            ),
        },
        "dates": dates,
    }
    bucket.put_object(
        MANIFEST_KEY,
        json.dumps(
            manifest,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8"),
        headers={"Cache-Control": "no-cache"},
    )
    return {"manifest": manifest, "published": published}


def load_market_day(bucket, date):
    date = _date(date)
    manifest = _json(bucket, MANIFEST_KEY)
    if manifest is None:
        return None
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        raise ValueError("市场数据manifest版本无效")
    entry = next(
        (row for row in manifest.get("dates", []) if row.get("date") == date),
        None,
    )
    if entry is None:
        return None
    encoded = bucket.get_object(entry["key"]).read()
    if hashlib.sha256(encoded).hexdigest() != entry.get("sha256"):
        raise ValueError("市场数据分片摘要校验失败")
    artifact = json.loads(gzip.decompress(encoded).decode("utf-8"))
    if artifact.get("schemaVersion") != SCHEMA_VERSION or artifact.get("date") != date:
        raise ValueError("市场数据分片内容无效")
    return artifact
