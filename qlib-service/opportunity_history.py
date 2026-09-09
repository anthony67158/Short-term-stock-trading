"""Version and load compact V3 opportunity outcomes in OSS."""

import gzip
import hashlib
import json
import time

from opportunity_dataset import (
    build_opportunity_dataset,
    opportunity_dataset_readiness,
)


HISTORY_SCHEMA_VERSION = "opportunity-history.v1"
HISTORY_MANIFEST_SCHEMA_VERSION = "opportunity-history-manifest.v1"
HISTORY_PREFIX = "opportunitymodel/training-data"
HISTORY_MANIFEST_KEY = f"{HISTORY_PREFIX}/manifest.json"


def _outcomes(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("outcomes"), list):
        return payload["outcomes"]
    raise ValueError("机会历史样本结构无效")


def normalize_history_outcomes(payload):
    unique = {}
    for value in _outcomes(payload):
        if (
            not isinstance(value, dict)
            or value.get("maturity") != "MATURED"
            or value.get("scoreInput", {}).get("schemaVersion")
            != "opportunity-score-feature.v3"
        ):
            continue
        decision_id = str(value.get("decisionId") or "")
        if not decision_id.startswith("formula:"):
            continue
        unique[decision_id] = value
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
