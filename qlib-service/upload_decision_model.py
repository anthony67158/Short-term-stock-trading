"""Publish a structurally validated decision model directly to OSS."""

import argparse
import hashlib
import json
import os
import re
import time

from decision_engine.registry import (
    ARTIFACT_FILENAMES,
    DECISION_MANIFEST_SCHEMA_VERSION,
    artifact_filenames_for_metadata,
    validate_decision_metadata,
)
from model_lib import _oss_bucket


RELEASE_DECISION_SCHEMA_VERSION = "opportunity-selective-release.v1"


def _bucket():
    target = _oss_bucket()
    if target is None:
        raise RuntimeError("机会模型OSS未配置")
    return target


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_metadata(directory):
    path = os.path.join(directory, ARTIFACT_FILENAMES["meta"])
    with open(path, encoding="utf-8") as handle:
        metadata = json.load(handle)
    try:
        validate_decision_metadata(metadata)
    except ValueError as error:
        raise ValueError("机会模型文件或特征合同无效") from error
    run_id = str(metadata.get("modelVersion") or "")
    if (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,95}", run_id)
        or ".." in run_id
    ):
        raise ValueError("机会模型版本无效")
    return metadata, run_id, artifact_filenames_for_metadata(metadata)


def _validate_release_decision(value, run_id):
    if not isinstance(value, dict):
        raise ValueError("决策模型发布结果无效")
    if (
        value.get("schemaVersion")
        != RELEASE_DECISION_SCHEMA_VERSION
        or value.get("action") != "PUBLISH"
        or value.get("eligible") is not True
        or str(value.get("selectedVersion") or "") != run_id
        or not isinstance(value.get("promotedComponents"), list)
        or not value["promotedComponents"]
        or (value.get("compatibility") or {}).get("passed") is not True
    ):
        raise ValueError("决策模型发布结果未通过完整验证")
    return value


def publish_decision_release(
    target_bucket,
    directory,
    *,
    prefix="opportunitymodel/",
    activated_at=None,
    activate_baseline=False,
    release_decision=None,
):
    source = os.path.abspath(directory)
    metadata, run_id, artifact_filenames = _load_metadata(source)
    decision = (
        _validate_release_decision(release_decision, run_id)
        if release_decision is not None
        else None
    )
    normalized_prefix = str(prefix or "opportunitymodel/").strip("/")
    release_prefix = f"{normalized_prefix}/runs/{run_id}/"
    manifest_files = {}
    for slot, filename in artifact_filenames.items():
        path = os.path.join(source, filename)
        if not os.path.isfile(path):
            raise FileNotFoundError(path)
        key = release_prefix + filename
        target_bucket.put_object_from_file(
            key,
            path,
            headers={"x-oss-forbid-overwrite": "true"},
        )
        manifest_files[slot] = {
            "key": key,
            "sha256": _sha256(path),
            "size": os.path.getsize(path),
        }
    manifest = {
        "schemaVersion": DECISION_MANIFEST_SCHEMA_VERSION,
        "runId": run_id,
        "activatedAt": int(activated_at or time.time()),
        "usagePolicy": "DIRECT",
        "predictionContract": metadata.get(
            "predictionContract",
            "opportunity-three-head.v1",
        ),
        "shadowOnly": (
            False
            if activate_baseline
            else metadata.get("shadowOnly", True)
        ),
        "baselineSelected": bool(activate_baseline),
        "productionEligible": metadata.get(
            "productionEligible",
            False,
        ),
        "files": manifest_files,
    }
    if decision is not None:
        decision_payload = json.dumps(
            decision,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
        decision_key = (
            f"{normalized_prefix}/release-history/{run_id}.json"
        )
        target_bucket.put_object(
            decision_key,
            decision_payload,
            headers={"x-oss-forbid-overwrite": "true"},
        )
        manifest["releaseManagement"] = {
            "strategy": decision.get("releaseMode"),
            "parentRunId": decision.get("championVersion"),
            "challengerRunId": decision.get("challengerVersion"),
            "promotedComponents": decision["promotedComponents"],
            "decisionKey": decision_key,
            "decisionSha256": hashlib.sha256(
                decision_payload
            ).hexdigest(),
        }
    target_bucket.put_object(
        f"{normalized_prefix}/manifest.json",
        json.dumps(
            manifest,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8"),
    )
    return manifest


def main():
    parser = argparse.ArgumentParser(
        description="发布已通过门禁的模块化决策模型",
    )
    parser.add_argument("--directory", required=True)
    parser.add_argument(
        "--prefix",
        default=os.environ.get(
            "DECISION_MODEL_PREFIX",
            "opportunitymodel/",
        ),
    )
    parser.add_argument(
        "--activate-baseline",
        action="store_true",
        help="将当前最佳组合设为DIRECT基准，但不伪造生产门槛结果",
    )
    parser.add_argument(
        "--release-decision",
        help="通过整体兼容性验证的选择性发布决策JSON",
    )
    args = parser.parse_args()
    decision = None
    if args.release_decision:
        with open(args.release_decision, encoding="utf-8") as handle:
            decision = json.load(handle)
    manifest = publish_decision_release(
        _bucket(),
        args.directory,
        prefix=args.prefix,
        activate_baseline=args.activate_baseline,
        release_decision=decision,
    )
    print(json.dumps({
        "ok": True,
        "runId": manifest["runId"],
        "shadowOnly": manifest["shadowOnly"],
        "productionEligible": manifest["productionEligible"],
        "baselineSelected": manifest["baselineSelected"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
