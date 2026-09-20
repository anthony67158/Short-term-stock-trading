"""Immutable OSS storage for action-value experiment artifacts."""

import argparse
import hashlib
import json
import os
from pathlib import Path

from platform_app.modules.experiments.action_value_experiment import (
    SCHEMA_VERSION,
)
from platform_app.modules.experiments.retraining_dataset_store import (
    ROOT_PREFIX,
    _bucket,
    _file_sha256,
    _upload_bytes,
    _upload_file,
)


class ActionValueArtifactStoreError(ValueError):
    pass


def _manifest(root: Path) -> tuple[dict, str, list[tuple[Path, str]]]:
    root = root.resolve()
    manifest_path = root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text())
        evaluation = root / manifest["evaluation"]
        files = [(evaluation, manifest["evaluationSha256"])]
        files.extend(
            (root / item["path"], item["sha256"])
            for item in manifest["foldArtifacts"]
        )
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ActionValueArtifactStoreError(
            "ACTION_VALUE_ARTIFACT_MANIFEST_INVALID"
        ) from exc
    if (
        manifest.get("schemaVersion") != SCHEMA_VERSION
        or manifest.get("releaseStatus") != "UNAVAILABLE"
        or manifest.get("productionEligible") is not False
        or len(manifest.get("foldArtifacts", ())) != 5
        or any(not path.is_file() or _file_sha256(path) != expected for path, expected in files)
    ):
        raise ActionValueArtifactStoreError("ACTION_VALUE_ARTIFACT_MANIFEST_INVALID")
    manifest_hash = _file_sha256(manifest_path)
    return manifest, manifest_hash, files


def upload_experiment(root: Path) -> dict:
    manifest, manifest_hash, files = _manifest(root)
    status = (
        "development-passed"
        if manifest.get("gate", {}).get("passed")
        else "rejected"
    )
    prefix = f"{ROOT_PREFIX}/experiments/{status}/{manifest_hash}"
    bucket = _bucket()
    uploaded = {}
    for path, sha256 in files:
        uploaded[path.name] = _upload_file(
            bucket,
            f"{prefix}/{path.name}",
            path,
            sha256,
        )
    manifest_path = root.resolve() / "manifest.json"
    uploaded[manifest_path.name] = _upload_file(
        bucket,
        f"{prefix}/manifest.json",
        manifest_path,
        manifest_hash,
    )
    receipt = {
        "schemaVersion": "action-value-artifact-receipt.v1",
        "status": status,
        "manifestSha256": manifest_hash,
        "prefix": prefix,
        "files": uploaded,
        "productionPointerChanged": False,
    }
    receipt_payload = json.dumps(
        receipt,
        ensure_ascii=False,
        sort_keys=True,
        indent=2,
    ).encode() + b"\n"
    _upload_bytes(bucket, f"{prefix}/receipt.json", receipt_payload)
    return receipt


def restore_latest_passed(output: Path) -> dict:
    import oss2

    bucket = _bucket()
    prefix = f"{ROOT_PREFIX}/experiments/development-passed/"
    manifests = [
        item
        for item in oss2.ObjectIterator(bucket, prefix=prefix)
        if item.key.endswith("/manifest.json")
    ]
    if not manifests:
        return {"status": "NOT_FOUND"}
    latest = max(
        manifests,
        key=lambda item: (int(item.last_modified or 0), item.key),
    )
    payload = bucket.get_object(latest.key).read()
    manifest_hash = Path(latest.key).parent.name
    if hashlib.sha256(payload).hexdigest() != manifest_hash:
        raise ActionValueArtifactStoreError("ACTION_VALUE_ARTIFACT_HASH_MISMATCH")
    try:
        manifest = json.loads(payload)
        names = [
            manifest["evaluation"],
            *(item["path"] for item in manifest["foldArtifacts"]),
        ]
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ActionValueArtifactStoreError(
            "ACTION_VALUE_ARTIFACT_MANIFEST_INVALID"
        ) from exc
    target = output.resolve()
    if target.exists():
        raise ActionValueArtifactStoreError("ACTION_VALUE_ARTIFACT_OUTPUT_EXISTS")
    target.mkdir(parents=True)
    prefix = str(Path(latest.key).parent)
    for name in names:
        if Path(name).name != name:
            raise ActionValueArtifactStoreError(
                "ACTION_VALUE_ARTIFACT_MANIFEST_INVALID"
            )
        oss2.resumable_download(
            bucket,
            f"{prefix}/{name}",
            str(target / name),
        )
    (target / "manifest.json").write_bytes(payload)
    _manifest(target)
    return {
        "status": "RESTORED",
        "manifestSha256": manifest_hash,
        "output": str(target),
        "productionPointerChanged": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["upload", "restore-latest-passed"])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = (
        upload_experiment(args.root)
        if args.command == "upload"
        else restore_latest_passed(args.root)
    )
    rendered = json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_text(rendered)
        os.replace(temporary, args.output)
    print(rendered, end="")


if __name__ == "__main__":
    main()
