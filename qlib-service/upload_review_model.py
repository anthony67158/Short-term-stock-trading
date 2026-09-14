"""Publish a validated trigger-review ensemble to OSS."""

import argparse
import hashlib
import json
import os
import re
import time

from decision_engine.review_registry import (
    REVIEW_ARTIFACT_FILENAMES,
    REVIEW_MANIFEST_SCHEMA_VERSION,
    validate_review_metadata,
)
from model_lib import _oss_bucket


def _bucket():
    target = _oss_bucket()
    if target is None:
        raise RuntimeError("触价复核模型OSS未配置")
    return target


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_release_decision(value, run_id):
    compatibility = (
        value.get("compatibility")
        if isinstance(value, dict)
        else None
    )
    evidence = (
        value.get("freshHoldout")
        if isinstance(value, dict)
        else None
    )
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion")
        != "review-champion-challenger.v1"
        or value.get("action") != "PUBLISH"
        or value.get("eligible") is not True
        or not str(value.get("championVersion") or "")
        or value.get("championVersion") == run_id
        or value.get("challengerVersion") != run_id
        or value.get("selectedVersion") != run_id
        or not isinstance(compatibility, dict)
        or compatibility.get("passed") is not True
        or compatibility.get("blockers") != []
        or not compatibility.get("improvements")
        or not isinstance(evidence, dict)
        or int(evidence.get("dates") or 0) < 10
        or int(evidence.get("conditionalSamples") or 0) < 200
        or int(evidence.get("fillSamples") or 0) < 500
        or int(evidence.get("opportunitySamples") or 0) < 500
    ):
        raise ValueError("触价复核模型缺少有效冠军挑战者发布裁决")
    return value


def record_confirmation_attempt(
    target_bucket,
    metadata,
    *,
    prefix="opportunitymodel/review/",
    recorded_at=None,
):
    audit = metadata["confirmationAudit"]
    normalized_prefix = str(
        prefix or "opportunitymodel/review/"
    ).strip("/")
    key = (
        f"{normalized_prefix}/confirmation-audits/"
        f"{audit['confirmationDataHash']}.json"
    )
    payload = {
        **audit,
        "runId": metadata["modelVersion"],
        "productionEligible":
            metadata.get("productionEligible") is True,
        "recordedAt": int(recorded_at or time.time()),
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    try:
        target_bucket.put_object(
            key,
            encoded,
            headers={"x-oss-forbid-overwrite": "true"},
        )
    except Exception as error:
        try:
            existing = json.loads(
                target_bucket.get_object(key).read().decode("utf-8")
            )
        except Exception:
            raise error
        if (
            existing.get("runId") == payload["runId"]
            and existing.get("candidateHash") == payload["candidateHash"]
        ):
            return existing
        raise ValueError("最终确认数据已用于另一候选选择") from error
    return payload


def publish_review_release(
    target_bucket,
    directory,
    *,
    release_decision,
    prefix="opportunitymodel/review/",
    activated_at=None,
):
    source = os.path.abspath(directory)
    metadata_path = os.path.join(
        source,
        REVIEW_ARTIFACT_FILENAMES["meta"],
    )
    with open(metadata_path, encoding="utf-8") as handle:
        metadata = validate_review_metadata(json.load(handle))
    run_id = str(metadata["modelVersion"])
    if (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,95}", run_id)
        or ".." in run_id
    ):
        raise ValueError("触价复核模型版本无效")
    decision = validate_release_decision(release_decision, run_id)
    normalized_prefix = str(
        prefix or "opportunitymodel/review/"
    ).strip("/")
    confirmation_audit = record_confirmation_attempt(
        target_bucket,
        metadata,
        prefix=normalized_prefix,
        recorded_at=activated_at,
    )
    if metadata.get("productionEligible") is not True:
        raise ValueError("触价复核模型未通过生产门禁")

    release_prefix = f"{normalized_prefix}/runs/{run_id}/"
    files = {}
    for slot, filename in REVIEW_ARTIFACT_FILENAMES.items():
        path = os.path.join(source, filename)
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        key = release_prefix + filename
        target_bucket.put_object_from_file(
            key,
            path,
            headers={"x-oss-forbid-overwrite": "true"},
        )
        files[slot] = {
            "key": key,
            "sha256": _sha256(path),
            "size": os.path.getsize(path),
        }
    decision_payload = json.dumps(
        decision,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    decision_key = release_prefix + "release_decision.json"
    target_bucket.put_object(
        decision_key,
        decision_payload,
        headers={"x-oss-forbid-overwrite": "true"},
    )
    manifest = {
        "schemaVersion": REVIEW_MANIFEST_SCHEMA_VERSION,
        "runId": run_id,
        "activatedAt": int(activated_at or time.time()),
        "usagePolicy": "DIRECT",
        "predictionContract": metadata["predictionContract"],
        "featureSchemaVersion": metadata["featureSchemaVersion"],
        "priceContractSchemaVersion":
            metadata["priceContractSchemaVersion"],
        "labelContractVersion": metadata["labelContractVersion"],
        "exitPolicyVersion": metadata["exitPolicyVersion"],
        "riskProfileVersion": metadata["riskProfileVersion"],
        "productionEligible": True,
        "baselineSelected": True,
        "confirmationAudit": confirmation_audit,
        "promotionDecision": {
            "key": decision_key,
            "sha256": hashlib.sha256(decision_payload).hexdigest(),
        },
        "files": files,
    }
    target_bucket.put_object(
        f"{normalized_prefix}/manifest.json",
        json.dumps(
            manifest,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8"),
    )
    return manifest


def main():
    parser = argparse.ArgumentParser(
        description="发布已通过门禁的触价复核动作价值模型",
    )
    parser.add_argument("--directory", required=True)
    parser.add_argument(
        "--prefix",
        default=os.environ.get(
            "DECISION_REVIEW_MODEL_PREFIX",
            "opportunitymodel/review/",
        ),
    )
    parser.add_argument("--record-only", action="store_true")
    parser.add_argument("--release-decision")
    args = parser.parse_args()
    if args.record_only:
        source = os.path.abspath(args.directory)
        metadata_path = os.path.join(
            source,
            REVIEW_ARTIFACT_FILENAMES["meta"],
        )
        with open(metadata_path, encoding="utf-8") as handle:
            metadata = validate_review_metadata(json.load(handle))
        audit = record_confirmation_attempt(
            _bucket(),
            metadata,
            prefix=args.prefix,
        )
        print(json.dumps({
            "ok": True,
            "runId": audit["runId"],
            "productionEligible": audit["productionEligible"],
            "confirmationDataHash": audit["confirmationDataHash"],
        }, ensure_ascii=False))
        return
    if not args.release_decision:
        raise ValueError("发布触价复核模型必须提供冠军挑战者裁决")
    with open(args.release_decision, encoding="utf-8") as handle:
        release_decision = json.load(handle)
    manifest = publish_review_release(
        _bucket(),
        args.directory,
        release_decision=release_decision,
        prefix=args.prefix,
    )
    print(json.dumps({
        "ok": True,
        "runId": manifest["runId"],
        "productionEligible": True,
        "baselineSelected": True,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
