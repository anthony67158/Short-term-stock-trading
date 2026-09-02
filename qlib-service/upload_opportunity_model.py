"""Publish a validated opportunity shadow-model release to OSS."""

import argparse
import hashlib
import json
import os
import re
import time

from opportunity_model import (
    ARTIFACT_FILENAMES,
    MANIFEST_SCHEMA_VERSION,
    validate_opportunity_metadata,
)
from model_lib import _oss_bucket


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
        validate_opportunity_metadata(metadata)
    except ValueError as error:
        raise ValueError("机会模型未通过影子闸门") from error
    run_id = str(metadata.get("modelVersion") or "")
    if (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,95}", run_id)
        or ".." in run_id
    ):
        raise ValueError("机会模型版本无效")
    return metadata, run_id


def publish_opportunity_release(
    target_bucket,
    directory,
    *,
    prefix="opportunitymodel/",
    activated_at=None,
):
    source = os.path.abspath(directory)
    _, run_id = _load_metadata(source)
    normalized_prefix = str(prefix or "opportunitymodel/").strip("/")
    release_prefix = f"{normalized_prefix}/runs/{run_id}/"
    manifest_files = {}
    for slot, filename in ARTIFACT_FILENAMES.items():
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
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "runId": run_id,
        "activatedAt": int(activated_at or time.time()),
        "shadowOnly": True,
        "files": manifest_files,
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
        description="发布机会雷达影子模型",
    )
    parser.add_argument("--directory", required=True)
    parser.add_argument(
        "--prefix",
        default=os.environ.get(
            "OPPORTUNITY_MODEL_PREFIX",
            "opportunitymodel/",
        ),
    )
    args = parser.parse_args()
    manifest = publish_opportunity_release(
        _bucket(),
        args.directory,
        prefix=args.prefix,
    )
    print(json.dumps({
        "ok": True,
        "runId": manifest["runId"],
        "shadowOnly": True,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
