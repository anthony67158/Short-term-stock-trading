"""Version and load compact V3 opportunity outcomes in OSS."""

import gzip
import hashlib
import json
import math
import time

from decision_engine.training.datasets import (
    build_opportunity_dataset,
    opportunity_dataset_readiness,
)
from decision_engine.contracts import feature_names_for_schema


HISTORY_SCHEMA_VERSION = "opportunity-history.v1"
HISTORY_MANIFEST_SCHEMA_VERSION = "opportunity-history-manifest.v1"
HISTORY_PREFIX = "opportunitymodel/training-data"
HISTORY_MANIFEST_KEY = f"{HISTORY_PREFIX}/manifest.json"
PLANNED_RISK_BASIS = "PLANNED_PRICE_CONTRACT"


def _outcomes(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("outcomes"), list):
        return payload["outcomes"]
    raise ValueError("机会历史样本结构无效")


def _finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def repair_outcome_net_r(value):
    if (
        not isinstance(value, dict)
        or value.get("fillStatus") != "FILLED"
    ):
        return value
    metrics = value.get("metrics")
    if not isinstance(metrics, dict):
        return value
    if metrics.get("riskBasis") == PLANNED_RISK_BASIS:
        return value
    net_r = _finite(metrics.get("netR"))
    net_pnl = _finite(metrics.get("netPnl"))
    if net_r is None or net_pnl is None:
        return value
    entry_price = _finite((value.get("trigger") or {}).get("price"))
    quantity = _finite((value.get("entry") or {}).get("quantity"))
    stop_distance_pct = _finite(
        ((value.get("scoreInput") or {}).get("factors") or {}).get(
            "stopDistancePct",
        )
    )
    initial_risk_cash = (
        entry_price * stop_distance_pct / 100 * quantity
        if (
            entry_price is not None
            and entry_price > 0
            and quantity is not None
            and quantity > 0
            and stop_distance_pct is not None
            and stop_distance_pct > 0
        )
        else None
    )
    if not initial_risk_cash:
        raise ValueError("成熟成交样本缺少计划风险口径")
    repaired = dict(value)
    repaired_metrics = dict(metrics)
    previous_risk = _finite(metrics.get("initialRiskCash"))
    if previous_risk is not None:
        repaired_metrics["actualFillRiskCash"] = round(previous_risk, 2)
    repaired_metrics.update({
        "initialRiskCash": round(initial_risk_cash, 2),
        "netR": round(net_pnl / initial_risk_cash, 3),
        "riskBasis": PLANNED_RISK_BASIS,
    })
    repaired["metrics"] = repaired_metrics
    return repaired


def normalize_history_outcomes(payload):
    unique = {}
    for value in _outcomes(payload):
        if not isinstance(value, dict) or value.get("maturity") != "MATURED":
            continue
        try:
            feature_names_for_schema(
                value.get("scoreInput", {}).get("schemaVersion")
            )
        except ValueError:
            continue
        decision_id = str(value.get("decisionId") or "")
        if not decision_id.startswith("formula:"):
            continue
        unique[decision_id] = repair_outcome_net_r(value)
    return sorted(
        unique.values(),
        key=lambda value: (
            str(value.get("tradeDate") or ""),
            str(value.get("decisionId") or ""),
        ),
    )


def build_history_artifact(payload, *, generated_at=None, readiness=None):
    outcomes = normalize_history_outcomes(payload)
    dataset = build_opportunity_dataset(outcomes)
    status = opportunity_dataset_readiness(
        dataset,
        **(readiness or {}),
    )
    if not status["ready"]:
        raise ValueError(
            "机会历史样本未达到训练要求: "
            + "、".join(status["blockers"])
        )
    return {
        "schemaVersion": HISTORY_SCHEMA_VERSION,
        "generatedAt": int(generated_at or time.time() * 1000),
        "summary": {
            "samples": status["samples"],
            "filledSamples": status["filled_samples"],
            "dates": status["dates"],
            "riskBasis": PLANNED_RISK_BASIS,
        },
        "outcomes": outcomes,
    }


def encode_history_artifact(artifact):
    raw = json.dumps(
        artifact,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return gzip.compress(raw, compresslevel=9, mtime=0)


def _json_object(bucket, key):
    try:
        return json.loads(bucket.get_object(key).read().decode("utf-8"))
    except Exception as error:
        if (
            isinstance(error, KeyError)
            or
            getattr(error, "status", None) == 404
            or getattr(error, "code", None) == "NoSuchKey"
        ):
            return None
        raise


def publish_opportunity_history(
    bucket,
    payload,
    *,
    generated_at=None,
    readiness=None,
):
    artifact = build_history_artifact(
        payload,
        generated_at=generated_at,
        readiness=readiness,
    )
    encoded = encode_history_artifact(artifact)
    digest = hashlib.sha256(encoded).hexdigest()
    version = int(artifact["generatedAt"])
    key = f"{HISTORY_PREFIX}/runs/{version}-{digest[:16]}.json.gz"
    bucket.put_object(
        key,
        encoded,
        headers={"x-oss-forbid-overwrite": "true"},
    )
    manifest = {
        "schemaVersion": HISTORY_MANIFEST_SCHEMA_VERSION,
        "activatedAt": version,
        "key": key,
        "sha256": digest,
        "size": len(encoded),
        "summary": artifact["summary"],
    }
    bucket.put_object(
        HISTORY_MANIFEST_KEY,
        json.dumps(
            manifest,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8"),
    )
    return manifest


def load_opportunity_history(bucket):
    manifest = _json_object(bucket, HISTORY_MANIFEST_KEY)
    if manifest is None:
        return []
    if (
        manifest.get("schemaVersion") != HISTORY_MANIFEST_SCHEMA_VERSION
        or not str(manifest.get("key") or "").startswith(
            f"{HISTORY_PREFIX}/runs/"
        )
    ):
        raise ValueError("机会历史样本清单无效")
    encoded = bucket.get_object(manifest["key"]).read()
    digest = hashlib.sha256(encoded).hexdigest()
    if digest != manifest.get("sha256"):
        raise ValueError("机会历史样本摘要校验失败")
    artifact = json.loads(gzip.decompress(encoded).decode("utf-8"))
    if artifact.get("schemaVersion") != HISTORY_SCHEMA_VERSION:
        raise ValueError("机会历史样本版本无效")
    outcomes = normalize_history_outcomes(artifact)
    if len(outcomes) != int(artifact.get("summary", {}).get("samples") or 0):
        raise ValueError("机会历史样本数量校验失败")
    return outcomes
