"""Download and verify the active decision-model release from OSS."""

import argparse
import hashlib
import json
import os

from model_lib import _oss_bucket
from decision_engine.registry import (
    ARTIFACT_FILENAMES,
    DECISION_MANIFEST_SCHEMA_VERSION,
    ENSEMBLE_ARTIFACT_FILENAMES,
    LEGACY_ARTIFACT_FILENAMES,
    LEGACY_MANIFEST_SCHEMA_VERSION,
    validate_decision_metadata,
)


def _sha256_bytes(payload):
    return hashlib.sha256(payload).hexdigest()


def _manifest_layout(manifest):
    files = manifest.get("files")
    for layout in (
        ENSEMBLE_ARTIFACT_FILENAMES,
        ARTIFACT_FILENAMES,
        LEGACY_ARTIFACT_FILENAMES,
    ):
        if isinstance(files, dict) and set(files) == set(layout):
            return layout
    raise ValueError("生产决策模型文件清单不完整")


def download_active_release(
    bucket,
    output_directory,
    *,
    prefix="opportunitymodel/",
):
    normalized_prefix = str(prefix or "opportunitymodel/").strip("/")
    manifest_key = f"{normalized_prefix}/manifest.json"
    payload = bucket.get_object(manifest_key).read()
    manifest = json.loads(payload.decode("utf-8"))
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") not in {
            DECISION_MANIFEST_SCHEMA_VERSION,
            LEGACY_MANIFEST_SCHEMA_VERSION,
        }
    ):
        raise ValueError("生产决策模型清单版本无效")
    run_id = str(manifest.get("runId") or "")
    expected_prefix = f"{normalized_prefix}/runs/{run_id}/"
    layout = _manifest_layout(manifest)
    os.makedirs(output_directory, exist_ok=True)
    temporary = []
    try:
        for slot, filename in layout.items():
            item = manifest["files"].get(slot) or {}
            key = str(item.get("key") or "")
            checksum = str(item.get("sha256") or "")
            if (
                not key.startswith(expected_prefix)
                or not key.endswith(filename)
                or ".." in key
            ):
                raise ValueError("生产决策模型文件路径无效")
            content = bucket.get_object(key).read()
            if _sha256_bytes(content) != checksum:
                raise ValueError("生产决策模型文件摘要不匹配")
            destination = os.path.join(output_directory, filename)
            temporary_path = destination + ".part"
            temporary.append(temporary_path)
            with open(temporary_path, "wb") as handle:
                handle.write(content)
        metadata_path = os.path.join(
            output_directory,
            layout["meta"],
        ) + ".part"
        with open(metadata_path, encoding="utf-8") as handle:
            metadata = validate_decision_metadata(
                json.load(handle),
                run_id,
            )
        if (
            metadata.get("predictionContract")
            != manifest.get("predictionContract")
        ):
            raise ValueError("生产决策模型预测合同与清单不一致")
        for filename in layout.values():
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
        description="下载当前生产决策模型作为每日训练对照组",
    )
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--prefix",
        default=os.environ.get(
            "DECISION_MODEL_PREFIX",
            "opportunitymodel/",
        ),
    )
    args = parser.parse_args()
    bucket = _oss_bucket()
    if bucket is None:
        raise RuntimeError("机会模型OSS未配置")
    manifest = download_active_release(
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
