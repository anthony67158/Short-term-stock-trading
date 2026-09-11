"""Build a compact, point-in-time strategy-pattern index from market archives."""

import gzip
import hashlib
import json
import math
import time

from opportunity_market_archive import (
    MANIFEST_KEY as MARKET_MANIFEST_KEY,
    MANIFEST_SCHEMA_VERSION as MARKET_MANIFEST_SCHEMA_VERSION,
    _load_market_day_entry,
)


SCHEMA_VERSION = "strategy-pattern-snapshot.v1"
MANIFEST_SCHEMA_VERSION = "strategy-pattern-snapshot-manifest.v1"
PREFIX = "opportunitymodel/pattern-data/v1"
MANIFEST_KEY = f"{PREFIX}/manifest.json"
MIN_HISTORY_DAYS = 21
MAX_HISTORY_DAYS = 61


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _clamp(value, minimum=0.0, maximum=100.0):
    return max(minimum, min(maximum, value))


def _ascending(value, floor, target):
    if value is None or target <= floor:
        return 0.0
    return _clamp((value - floor) / (target - floor) * 100.0)


def _descending(value, target, ceiling):
    if value is None or ceiling <= target:
        return 0.0
    return _clamp((ceiling - value) / (ceiling - target) * 100.0)


def _proximity(value, center, width):
    if value is None or width <= 0:
        return 0.0
    return _clamp(100.0 - abs(value - center) / width * 100.0)


def _average(values):
    clean = [value for value in values if value is not None]
    return sum(clean) / len(clean) if clean else None


def _sample_std(values):
    clean = [value for value in values if value is not None]
    if len(clean) < 2:
        return None
    mean = _average(clean)
    return math.sqrt(
        sum((value - mean) ** 2 for value in clean) / (len(clean) - 1)
    )


def _valid_bar(value):
    if not isinstance(value, dict):
        return None
    open_price = _number(value.get("open"))
    high = _number(value.get("high"))
    low = _number(value.get("low"))
    close = _number(value.get("close"))
    if (
        not all(item is not None and item > 0 for item in (
            open_price,
            high,
            low,
            close,
        ))
        or high < max(open_price, close)
        or low > min(open_price, close)
    ):
        return None
    return {
        "date": str(value.get("date") or ""),
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "volume": _number(value.get("volume")),
    }


def _sma(values, period, offset=0):
    end = len(values) - offset
    start = end - period
    if start < 0 or end <= start:
        return None
    return _average(values[start:end])


def strategy_pattern_scores(rows):
    normalized = [bar for bar in (_valid_bar(row) for row in rows) if bar]
    bars = sorted(
        {bar["date"].replace("-", "") or i: bar for i, bar in enumerate(normalized)}.values(),
        key=lambda row: row["date"],
    )[-MAX_HISTORY_DAYS:]
    if not bars:
        return None
    current = bars[-1]
    closes = [bar["close"] for bar in bars]
    volumes = [bar["volume"] for bar in bars]
    previous_close = bars[-2]["close"] if len(bars) >= 2 else None
    ma20 = _sma(closes, 20)
    previous_ma20 = _sma(closes, 20, 1)
    ma60 = _sma(closes, 60)
    momentum20 = (
        (current["close"] / bars[-21]["close"] - 1.0) * 100.0
        if len(bars) >= 21
        else None
    )
    momentum5 = (
        (current["close"] / bars[-6]["close"] - 1.0) * 100.0
        if len(bars) >= 6
        else None
    )
    prior = bars[-11:-1]
    prior_high = max((bar["high"] for bar in prior), default=None)
    prior_low = min((bar["low"] for bar in prior), default=None)
    platform_range = (
        (prior_high - prior_low) / current["close"] * 100.0
        if len(prior) == 10 and current["close"] > 0
        else None
    )
    breakout_distance = (
        (current["close"] / prior_high - 1.0) * 100.0
        if prior_high is not None and prior_high > 0
        else None
    )
    prior_volumes = volumes[-6:-1]
    prior_volume5 = (
        _average(prior_volumes)
        if len(prior_volumes) == 5
        and all(value is not None and value > 0 for value in prior_volumes)
        else None
    )
    volume_ratio = (
        current["volume"] / prior_volume5
        if current["volume"] is not None
        and prior_volume5 is not None
        and prior_volume5 > 0
        else None
    )
    ma20_distance = (
        (current["close"] / ma20 - 1.0) * 100.0
        if ma20 is not None and ma20 > 0
        else None
    )
    ma60_distance = (
        (current["close"] / ma60 - 1.0) * 100.0
        if ma60 is not None and ma60 > 0
        else None
    )
    ma20_cross = bool(
        previous_close is not None
        and ma20 is not None
        and previous_ma20 is not None
        and current["close"] > ma20
        and previous_close <= previous_ma20
    )
    lower_shadow = (
        (min(current["open"], current["close"]) - current["low"])
        / previous_close * 100.0
        if previous_close is not None and previous_close > 0
        else None
    )
    close_location = (
        (current["close"] - current["low"])
        / (current["high"] - current["low"]) * 100.0
        if current["high"] > current["low"]
        else None
    )
    annual_vol = None
    if len(closes) >= 21:
        recent = closes[-21:]
        returns = [
            recent[index] / recent[index - 1] - 1.0
            for index in range(1, len(recent))
        ]
        daily_vol = _sample_std(returns)
        annual_vol = (
            daily_vol * math.sqrt(252.0) * 100.0
            if daily_vol is not None
            else None
        )

    compression = _descending(platform_range, 4, 12)
    breakout = _ascending(breakout_distance, -1, 1)
    expanded_volume = _ascending(volume_ratio, 1, 2)
    contracted_volume = _descending(volume_ratio, 0.6, 1.2)
    ma20_proximity = _proximity(ma20_distance, 0, 4)
    above_ma60 = _ascending(ma60_distance, -2, 4)
    positive_momentum = _ascending(momentum20, 0, 8)
    shadow_score = _ascending(lower_shadow, 1, 4)
    oversold = _descending(momentum5, -5, 2)
    recovered = _ascending(close_location, 35, 75)
    low_volatility = _descending(annual_vol, 20, 45)
    above_ma20 = _ascending(ma20_distance, -1, 3)
    bullish = 100.0 if current["close"] > current["open"] else 0.0

    result = {
        "historyCoverage": round(_clamp(len(bars) / 60.0, 0.0, 1.0), 6),
        "platformBreakout": round(
            compression * 0.45 + breakout * 0.35
            + expanded_volume * 0.2,
            6,
        ),
        "supportPullback": round(
            ma20_proximity * 0.35 + contracted_volume * 0.25
            + above_ma60 * 0.2 + positive_momentum * 0.2,
            6,
        ),
        "volumePriceSurge": round(
            (100.0 if ma20_cross else above_ma20 * 0.35) * 0.4
            + expanded_volume * 0.35 + bullish * 0.25,
            6,
        ),
        "lowerShadowReversal": round(
            shadow_score * 0.35 + oversold * 0.25
            + recovered * 0.25 + expanded_volume * 0.15,
            6,
        ),
        "lowVolTrend": round(
            positive_momentum * 0.35 + low_volatility * 0.35
            + above_ma20 * 0.3,
            6,
        ),
    }
    tradable = current["volume"] != 0
    has_volume = volume_ratio is not None and volume_ratio > 0
    for name, minimum in (
        ("platformBreakout", 11), ("supportPullback", 60),
        ("volumePriceSurge", 21), ("lowerShadowReversal", 6),
        ("lowVolTrend", 21),
    ):
        if not tradable or len(bars) < minimum or (
            name != "lowVolTrend" and not has_volume
        ):
            result[name] = 0.0
    return result


def build_strategy_pattern_snapshot(artifacts, *, generated_at=None):
    ordered = sorted(
        (
            artifact for artifact in artifacts
            if isinstance(artifact, dict)
            and str(artifact.get("date") or "").isdigit()
        ),
        key=lambda artifact: artifact["date"],
    )[-MAX_HISTORY_DAYS:]
    if len(ordered) < MIN_HISTORY_DAYS:
        raise ValueError("形态快照历史交易日不足")
    by_code = {}
    for artifact in ordered:
        for row in artifact.get("daily") or []:
            code = str(row.get("code") or "")
            if len(code) != 6 or not code.isdigit():
                continue
            by_code.setdefault(code, []).append(row)
    latest = ordered[-1]["date"]
    latest_codes = {
        str(row.get("code") or "")
        for row in ordered[-1].get("daily") or []
    }
    stocks = {}
    for code in sorted(latest_codes):
        scores = strategy_pattern_scores(by_code.get(code) or [])
        if scores is not None:
            stocks[code] = scores
    if len(stocks) < 800:
        raise ValueError("形态快照全市场覆盖不足")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "asOfDate": latest,
        "generatedAt": int(generated_at or time.time() * 1000),
        "summary": {
            "stocks": len(stocks),
            "historyDays": len(ordered),
            "fullHistoryStocks": sum(
                value["historyCoverage"] >= 1 for value in stocks.values()
            ),
        },
        "stocks": stocks,
    }


def _json_object(bucket, key):
    try:
        return json.loads(bucket.get_object(key).read().decode("utf-8"))
    except Exception as error:
        if (
            getattr(error, "status", None) == 404
            or getattr(error, "code", None) == "NoSuchKey"
        ):
            return None
        raise


def publish_strategy_pattern_snapshot(bucket, market_manifest):
    if (
        not isinstance(market_manifest, dict)
        or market_manifest.get("schemaVersion")
        != MARKET_MANIFEST_SCHEMA_VERSION
    ):
        raise ValueError("市场数据manifest版本无效")
    entries = list(market_manifest.get("dates") or [])[-MAX_HISTORY_DAYS:]
    artifacts = [
        _load_market_day_entry(bucket, entry)
        for entry in entries
    ]
    snapshot = build_strategy_pattern_snapshot(artifacts)
    encoded = gzip.compress(
        json.dumps(
            snapshot,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8"),
        compresslevel=9,
        mtime=0,
    )
    digest = hashlib.sha256(encoded).hexdigest()
    key = f"{PREFIX}/runs/{snapshot['asOfDate']}-{digest[:16]}.json.gz"
    try:
        bucket.put_object(
            key,
            encoded,
            headers={"x-oss-forbid-overwrite": "true"},
        )
    except Exception as error:
        if getattr(error, "status", None) != 409:
            raise
    manifest = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "activatedAt": snapshot["generatedAt"],
        "asOfDate": snapshot["asOfDate"],
        "key": key,
        "sha256": digest,
        "size": len(encoded),
        "summary": snapshot["summary"],
    }
    bucket.put_object(
        MANIFEST_KEY,
        json.dumps(
            manifest,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8"),
    )
    return manifest


def refresh_strategy_pattern_snapshot(bucket, market_manifest=None):
    manifest = market_manifest or _json_object(bucket, MARKET_MANIFEST_KEY)
    if manifest is None:
        raise ValueError("市场数据manifest不存在")
    entries = list(manifest.get("dates") or [])
    if len(entries) < MIN_HISTORY_DAYS:
        return {
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "status": "not_ready",
            "asOfDate": (
                str(entries[-1].get("date") or "")
                if entries
                else None
            ),
            "summary": {
                "stocks": 0,
                "historyDays": len(entries),
                "fullHistoryStocks": 0,
            },
        }
    return publish_strategy_pattern_snapshot(bucket, manifest)


def load_strategy_pattern_snapshot(bucket):
    manifest = _json_object(bucket, MANIFEST_KEY)
    if manifest is None:
        return None
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        raise ValueError("形态快照manifest版本无效")
    encoded = bucket.get_object(manifest["key"]).read()
    if hashlib.sha256(encoded).hexdigest() != manifest.get("sha256"):
        raise ValueError("形态快照摘要校验失败")
    snapshot = json.loads(gzip.decompress(encoded).decode("utf-8"))
    if (
        snapshot.get("schemaVersion") != SCHEMA_VERSION
        or snapshot.get("asOfDate") != manifest.get("asOfDate")
    ):
        raise ValueError("形态快照内容无效")
    return snapshot
