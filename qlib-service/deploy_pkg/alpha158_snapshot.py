"""Build and publish a point-in-time Alpha158 ranking snapshot."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import re
import time

from model_lib import _oss_bucket


SCHEMA_VERSION = "alpha158-ranking-snapshot.v1"
MANIFEST_SCHEMA_VERSION = "alpha158-ranking-manifest.v1"
PREFIX = "opportunitymodel/alpha158"
ACTIVE_MANIFEST_KEY = f"{PREFIX}/manifest.json"
RESEARCH_MANIFEST_KEY = f"{PREFIX}/research-manifest.json"
MAIN_BOARD_PATTERN = re.compile(
    r"^(?:000|001|002|003|600|601|603|605)\d{3}$"
)
QUALITY_THRESHOLDS = {
    "minimumStocks": 500,
    "minimumRecentDays": 20,
    "minimumOverallRankIc": 0.01,
    "minimumRecentRankIc": 0.01,
    "minimumRecentIc": 0.0,
    "maximumWeight": 0.25,
    "minimumPromotionLift": 0.005,
    "maximumMetricDrop": 0.005,
}


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


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


def _encode(value):
    raw = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return gzip.compress(raw, compresslevel=9, mtime=0)


def _decode(encoded):
    return json.loads(gzip.decompress(encoded).decode("utf-8"))


def _latest_fold(payload):
    folds = [
        value
        for value in payload.get("folds") or []
        if isinstance(value, dict)
        and re.fullmatch(
            r"\d{8}",
            str(value.get("validationEndDate") or ""),
        )
    ]
    return max(
        folds,
        key=lambda value: value["validationEndDate"],
        default=None,
    )


def build_alpha158_snapshot(payload, *, generated_at=None):
    if (
        not isinstance(payload, dict)
        or payload.get("schemaVersion")
        != "mainboard-alpha158-walkforward.v1"
    ):
        raise ValueError("Alpha158扩展时序结果版本无效")
    latest_fold = _latest_fold(payload)
    overall = payload.get("overall") or {}
    latest_payload = payload.get("latest") or {}
    ranking_source = (
        latest_payload.get("rankings")
        if isinstance(latest_payload, dict)
        and latest_payload.get("rankings")
        else payload.get("rankings")
    )
    rankings = [
        row
        for row in ranking_source or []
        if isinstance(row, dict)
        and MAIN_BOARD_PATTERN.fullmatch(str(row.get("code") or ""))
        and re.fullmatch(r"\d{8}", str(row.get("date") or ""))
        and _number(row.get("score")) is not None
        and int(_number(row.get("rank")) or 0) > 0
    ]
    if not latest_fold or not rankings:
        raise ValueError("Alpha158扩展时序结果缺少有效折或排名")
    as_of_date = (
        str(latest_payload.get("date") or "")
        if latest_payload.get("rankings")
        else max(str(row["date"]) for row in rankings)
    )
    latest = [
        row for row in rankings
        if str(row["date"]) == as_of_date
    ]
    latest.sort(
        key=lambda row: (
            int(_number(row.get("rank")) or 0),
            str(row.get("code") or ""),
        )
    )
    thresholds = QUALITY_THRESHOLDS
    overall_rank_ic = _number(overall.get("RankIC"))
    overall_ic = _number(overall.get("IC"))
    recent_rank_ic = _number(latest_fold.get("RankIC"))
    recent_ic = _number(latest_fold.get("IC"))
    recent_days = int(_number(latest_fold.get("days")) or 0)
    blockers = []
    if len(latest) < thresholds["minimumStocks"]:
        blockers.append("最新横截面少于500只主板股票")
    if recent_days < thresholds["minimumRecentDays"]:
        blockers.append("最近验证折少于20个交易日")
    if (
        overall_rank_ic is None
        or overall_rank_ic < thresholds["minimumOverallRankIc"]
    ):
        blockers.append("整体Rank IC低于0.01")
    if (
        recent_rank_ic is None
        or recent_rank_ic < thresholds["minimumRecentRankIc"]
    ):
        blockers.append("最近验证折Rank IC低于0.01")
    if recent_ic is None or recent_ic <= thresholds["minimumRecentIc"]:
        blockers.append("最近验证折IC未转正")
    eligible = not blockers
    strength = max(
        0.0,
        min(
            overall_rank_ic or 0.0,
            recent_rank_ic or 0.0,
        ),
    )
    reliability_weight = (
        min(
            thresholds["maximumWeight"],
            strength / 0.05 * thresholds["maximumWeight"],
        )
        if eligible
        else 0.0
    )
    denominator = max(1, len(latest) - 1)
    stocks = {}
    for index, row in enumerate(latest):
        rank = int(_number(row.get("rank")) or index + 1)
        stocks[str(row["code"])] = {
            "rawScore": round(float(row["score"]), 8),
            "percentile": round(
                max(0.0, min(1.0, 1.0 - (rank - 1) / denominator)),
                6,
            ),
            "rank": rank,
            "scoreMomentum5": _number(row.get("scoreMomentum5")),
        }
    timestamp = int(generated_at or time.time() * 1000)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "state": "ACTIVE" if eligible else "RESEARCH",
        "productionEligible": eligible,
        "asOfDate": as_of_date,
        "generatedAt": timestamp,
        "modelVersion": f"alpha158-rank.{timestamp}",
        "reliabilityWeight": round(reliability_weight, 6),
        "metrics": {
            "overallIc": overall_ic,
            "overallRankIc": overall_rank_ic,
            "overallIcir": _number(overall.get("ICIR")),
            "recentIc": recent_ic,
            "recentRankIc": recent_rank_ic,
            "recentIcir": _number(latest_fold.get("ICIR")),
            "recentDays": recent_days,
        },
        "qualityGate": {
            "passed": eligible,
            "blockers": blockers,
            "thresholds": thresholds,
        },
        "summary": {
            "stocks": len(stocks),
            "sourceDays": int(_number(overall.get("days")) or 0),
        },
        "stocks": stocks,
    }


def validate_alpha158_snapshot(value):
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != SCHEMA_VERSION
        or value.get("state") not in {"ACTIVE", "RESEARCH"}
        or not re.fullmatch(r"\d{8}", str(value.get("asOfDate") or ""))
        or not str(value.get("modelVersion") or "")
        or not isinstance(value.get("stocks"), dict)
        or not isinstance(value.get("qualityGate"), dict)
    ):
        raise ValueError("Alpha158排名快照无效")
    if (
        value.get("state") == "ACTIVE"
        and (
            value.get("productionEligible") is not True
            or value["qualityGate"].get("passed") is not True
            or (_number(value.get("reliabilityWeight")) or 0) <= 0
        )
    ):
        raise ValueError("Alpha158生产快照未通过质量门禁")
    for code, row in value["stocks"].items():
        percentile = _number((row or {}).get("percentile"))
        if (
            not MAIN_BOARD_PATTERN.fullmatch(str(code))
            or _number((row or {}).get("rawScore")) is None
            or percentile is None
            or not 0 <= percentile <= 1
            or int(_number((row or {}).get("rank")) or 0) < 1
            or (
                (row or {}).get("scoreMomentum5") is not None
                and _number((row or {}).get("scoreMomentum5")) is None
            )
        ):
            raise ValueError("Alpha158股票排名无效")
    return value


def _promotion_decision(current, candidate):
    if candidate["productionEligible"] is not True:
        return {
            "action": "KEEP_CURRENT",
            "reason": "挑战者未通过Alpha158质量门禁",
            "blockers": candidate["qualityGate"]["blockers"],
        }
    if current is None:
        return {
            "action": "PUBLISH",
            "reason": "首个通过质量门禁的Alpha158主板快照",
            "blockers": [],
        }
    candidate_metrics = candidate["metrics"]
    current_metrics = current["metrics"]
    threshold = QUALITY_THRESHOLDS
    overall_delta = (
        candidate_metrics["overallRankIc"]
        - current_metrics["overallRankIc"]
    )
    recent_delta = (
        candidate_metrics["recentRankIc"]
        - current_metrics["recentRankIc"]
    )
    blockers = []
    if overall_delta < -threshold["maximumMetricDrop"]:
        blockers.append("整体Rank IC下降超过0.005")
    if recent_delta < -threshold["maximumMetricDrop"]:
        blockers.append("最近验证折Rank IC下降超过0.005")
    if max(overall_delta, recent_delta) < threshold["minimumPromotionLift"]:
        blockers.append("Rank IC没有至少提升0.005")
    return {
        "action": "PUBLISH" if not blockers else "KEEP_CURRENT",
        "reason": (
            "Alpha158挑战者通过质量和相对改善门禁"
            if not blockers
            else "Alpha158挑战者未证明优于现役快照"
        ),
        "blockers": blockers,
    }


def _load_from_manifest(bucket, manifest):
    if manifest is None:
        return None
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        raise ValueError("Alpha158排名清单版本无效")
    encoded = bucket.get_object(manifest["key"]).read()
    if hashlib.sha256(encoded).hexdigest() != manifest.get("sha256"):
        raise ValueError("Alpha158排名快照摘要不匹配")
    value = validate_alpha158_snapshot(_decode(encoded))
    if (
        value["modelVersion"] != manifest.get("modelVersion")
        or value["asOfDate"] != manifest.get("asOfDate")
    ):
        raise ValueError("Alpha158排名清单与快照不一致")
    return value


def load_alpha158_snapshot(bucket):
    active = _load_from_manifest(
        bucket,
        _json(bucket, ACTIVE_MANIFEST_KEY),
    )
    if active is not None:
        return active
    return _load_from_manifest(
        bucket,
        _json(bucket, RESEARCH_MANIFEST_KEY),
    )


def publish_alpha158_snapshot(bucket, snapshot):
    candidate = validate_alpha158_snapshot(snapshot)
    current = _load_from_manifest(
        bucket,
        _json(bucket, ACTIVE_MANIFEST_KEY),
    )
    decision = _promotion_decision(current, candidate)
    encoded = _encode(candidate)
    digest = hashlib.sha256(encoded).hexdigest()
    key = (
        f"{PREFIX}/runs/{candidate['asOfDate']}-"
        f"{digest[:16]}.json.gz"
    )
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
        "activatedAt": candidate["generatedAt"],
        "asOfDate": candidate["asOfDate"],
        "modelVersion": candidate["modelVersion"],
        "state": candidate["state"],
        "key": key,
        "sha256": digest,
        "size": len(encoded),
        "metrics": candidate["metrics"],
        "promotionDecision": decision,
    }
    bucket.put_object(
        RESEARCH_MANIFEST_KEY,
        json.dumps(
            manifest,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8"),
    )
    if decision["action"] == "PUBLISH":
        bucket.put_object(
            ACTIVE_MANIFEST_KEY,
            json.dumps(
                manifest,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8"),
        )
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--walkforward", required=True)
    parser.add_argument("--output")
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    with open(args.walkforward, encoding="utf-8") as handle:
        snapshot = build_alpha158_snapshot(json.load(handle))
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump(snapshot, handle, ensure_ascii=False, indent=2)
    result = {"snapshot": snapshot}
    if args.publish:
        bucket = _oss_bucket()
        if bucket is None:
            raise RuntimeError("Alpha158排名快照OSS未配置")
        result["manifest"] = publish_alpha158_snapshot(
            bucket,
            snapshot,
        )
    print(json.dumps({
        "modelVersion": snapshot["modelVersion"],
        "state": snapshot["state"],
        "asOfDate": snapshot["asOfDate"],
        "stocks": snapshot["summary"]["stocks"],
        "reliabilityWeight": snapshot["reliabilityWeight"],
        "promotion": (
            (result.get("manifest") or {}).get("promotionDecision")
        ),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
