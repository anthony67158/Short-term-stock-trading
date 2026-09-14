"""Download and verify the active trigger-review release from OSS."""

import argparse
import hashlib
import json
import os

from decision_engine.review_registry import (
    REVIEW_ARTIFACT_FILENAMES,
    validate_review_manifest,
    validate_review_metadata,
)
from model_lib import _oss_bucket


def _sha256_bytes(payload):
    return hashlib.sha256(payload).hexdigest()


def download_active_review_release(
    bucket,
    output_directory,
    *,
    prefix="opportunitymodel/review/",
):
    normalized_prefix = str(
        prefix or "opportunitymodel/review/"
    ).strip("/")
    manifest_key = f"{normalized_prefix}/manifest.json"
    manifest = validate_review_manifest(
        json.loads(
            bucket.get_object(manifest_key).read().decode("utf-8")
        ),
        normalized_prefix,
    )
    run_id = manifest["runId"]
    expected_prefix = f"{normalized_prefix}/runs/{run_id}/"
    os.makedirs(output_directory, exist_ok=True)
    temporary = []
    try:
        for slot, filename in REVIEW_ARTIFACT_FILENAMES.items():
            item = manifest["files"].get(slot) or {}
            key = str(item.get("key") or "")
            checksum = str(item.get("sha256") or "")
            if (
                not key.startswith(expected_prefix)
                or not key.endswith(filename)
                or ".." in key
            ):
                raise ValueError("生产复核模型文件路径无效")
            payload = bucket.get_object(key).read()
            if _sha256_bytes(payload) != checksum:
                raise ValueError("生产复核模型文件摘要不匹配")
            destination = os.path.join(output_directory, filename)
            temporary_path = destination + ".part"
            temporary.append(temporary_path)
            with open(temporary_path, "wb") as handle:
                handle.write(payload)
        metadata_path = os.path.join(
            output_directory,
            REVIEW_ARTIFACT_FILENAMES["meta"],
        ) + ".part"
        with open(metadata_path, encoding="utf-8") as handle:
            metadata = validate_review_metadata(
                json.load(handle),
                run_id,
                feature_schema=manifest["featureSchemaVersion"],
            )
        for field in (
            "predictionContract",
            "featureSchemaVersion",
            "priceContractSchemaVersion",
            "labelContractVersion",
            "exitPolicyVersion",
            "riskProfileVersion",
        ):
            if manifest.get(field) != metadata.get(field):
                raise ValueError("生产复核模型清单与元数据不一致")
        for filename in REVIEW_ARTIFACT_FILENAMES.values():
            destination = os.path.join(output_directory, filename)
            os.replace(destination + ".part", destination)
    except Exception:
        for path in temporary:
            try:
                os.remove(path)
            except OSError:
                pass
        raise
    return manifest


def main():
    parser = argparse.ArgumentParser(
        description="下载当前生产复核模型作为每日训练冠军",
    )
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--prefix",
        default=os.environ.get(
            "DECISION_REVIEW_MODEL_PREFIX",
            "opportunitymodel/review/",
        ),
    )
    args = parser.parse_args()
    bucket = _oss_bucket()
    if bucket is None:
        raise RuntimeError("触价复核模型OSS未配置")
    manifest = download_active_review_release(
        bucket,
        args.output,
        prefix=args.prefix,
    )
    print(json.dumps({
        "runId": manifest["runId"],
        "usagePolicy": manifest.get("usagePolicy"),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
