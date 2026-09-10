"""Publish compact V3 training readiness for the trading workbench."""

import argparse
import json
import os
import time

from model_lib import _oss_bucket
from opportunity_dataset import (
    MINIMUM_DATES,
    MINIMUM_FILLED_SAMPLES,
    MINIMUM_SAMPLES,
)


STATUS_SCHEMA_VERSION = "opportunity-training-status.v1"


def _count(value):
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _active_model(bucket, prefix):
    key = f"{str(prefix).strip('/')}/manifest.json"
    try:
        value = json.loads(
            bucket.get_object(key).read().decode("utf-8")
        )
    except Exception:
        return None
    if not isinstance(value, dict):
        return None
    return {
        "modelVersion": str(value.get("runId") or "") or None,
        "shadowOnly": value.get("shadowOnly") is not False,
        "productionEligible":
            value.get("productionEligible") is True,
        "activatedAt": _count(value.get("activatedAt")),
        "usagePolicy": value.get("usagePolicy"),
    }


def build_training_status(report, promotion=None, active_model=None):
    readiness = report.get("readiness") or {}
    blockers = list(readiness.get("blockers") or [])
    production = bool(
        (active_model or {}).get("productionEligible")
    )
    direct = (active_model or {}).get("usagePolicy") == "DIRECT"
    ensemble = report.get("seedEnsemble") or {}
    ensemble_decision = ensemble.get("decision") or {}
    if direct and ensemble:
        reason = str(ensemble_decision.get("reason") or "").strip()
        promotion_blockers = (
            [reason] if ensemble_decision.get("eligible") is not True and reason
            else []
        )
    else:
        promotion_blockers = list(
            (promotion or {}).get("blockers")
            or report.get("productionBlockers")
            or report.get("shadowBlockers")
            or []
        )
    return {
        "schemaVersion": STATUS_SCHEMA_VERSION,
        "generatedAt": int(time.time() * 1000),
        "trainingGeneratedAt": _count(report.get("generatedAt")),
        "state": (
            "DIRECT_ACTIVE" if direct else "PRODUCTION_READY"
            if production
            else str(report.get("state") or "NOT_READY")
        ),
        "modelVersion":
            (active_model or {}).get("modelVersion")
            or report.get("modelVersion"),
        "shadowEligible": report.get("shadowEligible") is True,
        "productionEligible": production,
        "usagePolicy": "DIRECT" if direct else None,
        "readiness": {
            "samples": _count(readiness.get("samples")),
            "filledSamples": _count(
                readiness.get("filled_samples")
            ),
            "dates": _count(readiness.get("dates")),
            "requirements": {
                "samples": MINIMUM_SAMPLES,
                "filledSamples": MINIMUM_FILLED_SAMPLES,
                "dates": MINIMUM_DATES,
            },
            "blockers": [str(item)[:160] for item in blockers[:8]],
        },
        "promotionBlockers": [
            str(item)[:160]
            for item in promotion_blockers[:8]
        ],
        "activeModel": active_model,
    }


def publish_training_status(
    bucket,
    report_path,
    *,
    promotion_path=None,
    prefix="opportunitymodel/",
):
    with open(report_path, encoding="utf-8") as handle:
        report = json.load(handle)
    promotion = None
    if promotion_path and os.path.isfile(promotion_path):
        with open(promotion_path, encoding="utf-8") as handle:
            promotion = json.load(handle)
    status = build_training_status(
        report,
        promotion,
        _active_model(bucket, prefix),
    )
    key = f"{str(prefix).strip('/')}/training-status.json"
    bucket.put_object(
        key,
        json.dumps(
            status,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
        },
    )
    return status


def main():
    parser = argparse.ArgumentParser(
        description="发布V3机会模型训练状态",
    )
    parser.add_argument("--report", required=True)
    parser.add_argument("--promotion")
    parser.add_argument(
        "--prefix",
        default=os.environ.get(
            "OPPORTUNITY_MODEL_PREFIX",
            "opportunitymodel/",
        ),
    )
    args = parser.parse_args()
    bucket = _oss_bucket()
    if bucket is None:
        raise RuntimeError("机会模型OSS未配置")
    status = publish_training_status(
        bucket,
        args.report,
        promotion_path=args.promotion,
        prefix=args.prefix,
    )
    print(json.dumps(status, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
