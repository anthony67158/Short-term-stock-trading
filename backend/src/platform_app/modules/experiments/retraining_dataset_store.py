"""Immutable OSS checkpoints for action-value retraining datasets."""

import argparse
import hashlib
import json
import os
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

ROOT_PREFIX = "model-retraining/action-value/v1"
ALLOWED_OSS_ENDPOINT = "https://oss-cn-hangzhou.aliyuncs.com"
IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9._-]{2,79}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class RetrainingDatasetStoreError(ValueError):
    pass


@dataclass(frozen=True)
class DatasetSpec:
    database: str
    metadata_table: str


DATASET_SPECS = {
    "market": DatasetSpec("market.sqlite3", "dataset_metadata"),
    "episode": DatasetSpec("episodes.sqlite3", "episode_dataset_metadata"),
    "label": DatasetSpec("labels.sqlite3", "label_dataset_metadata"),
    "ranking": DatasetSpec("ranking.sqlite3", "ranking_dataset_metadata"),
}


def _canonical_bytes(value: dict) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _validated_identity(scope: str, kind: str, dataset_id: str) -> DatasetSpec:
    if scope not in {"smoke", "full"}:
        raise RetrainingDatasetStoreError("RETRAINING_SCOPE_INVALID")
    if kind not in DATASET_SPECS:
        raise RetrainingDatasetStoreError("RETRAINING_DATASET_KIND_INVALID")
    if not IDENTIFIER.fullmatch(dataset_id):
        raise RetrainingDatasetStoreError("RETRAINING_DATASET_ID_INVALID")
    return DATASET_SPECS[kind]


def _prefix(scope: str, kind: str, dataset_id: str) -> str:
    _validated_identity(scope, kind, dataset_id)
    return f"{ROOT_PREFIX}/{scope}/{dataset_id}/{kind}"


def _checkpoint_database(path: Path) -> tuple[str, dict[str, int]]:
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        integrity = connection.execute("PRAGMA integrity_check").fetchall()
        if integrity != [("ok",)]:
            raise RetrainingDatasetStoreError("RETRAINING_SQLITE_INTEGRITY_FAILED")
        tables = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
        counts = {}
        for table in tables:
            quoted = table.replace('"', '""')
            counts[table] = connection.execute(
                f'SELECT COUNT(*) FROM "{quoted}"'
            ).fetchone()[0]
    finally:
        connection.close()
    return _file_sha256(path), counts


def audit_dataset(root: Path, *, scope: str, kind: str, dataset_id: str) -> dict:
    spec = _validated_identity(scope, kind, dataset_id)
    dataset_root = root.resolve()
    database = dataset_root / spec.database
    if not database.is_file():
        raise RetrainingDatasetStoreError("RETRAINING_DATABASE_MISSING")
    database_hash, table_counts = _checkpoint_database(database)
    connection = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        metadata = connection.execute(
            f"SELECT dataset_id, schema_version FROM {spec.metadata_table}"
        ).fetchone()
    finally:
        connection.close()
    if metadata is None or metadata["dataset_id"] != dataset_id:
        raise RetrainingDatasetStoreError("RETRAINING_DATASET_IDENTITY_MISMATCH")

    manifest_path = dataset_root / "manifest.json"
    manifest = None
    manifest_hash = None
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (
            manifest.get("datasetId") != dataset_id
            or manifest.get("database") != spec.database
            or manifest.get("databaseSha256") != database_hash
        ):
            raise RetrainingDatasetStoreError("RETRAINING_MANIFEST_MISMATCH")
        manifest_hash = _file_sha256(manifest_path)

    report = {
        "schemaVersion": "action-value-dataset-checkpoint.v1",
        "scope": scope,
        "kind": kind,
        "datasetId": dataset_id,
        "datasetSchemaVersion": metadata["schema_version"],
        "database": spec.database,
        "databaseBytes": database.stat().st_size,
        "databaseSha256": database_hash,
        "sqliteIntegrity": "ok",
        "tables": table_counts,
        "sealed": manifest is not None,
        "manifestSha256": manifest_hash,
        "sourceRevision": os.environ.get("GITHUB_SHA", "local"),
        "productionPointerChanged": False,
    }
    report["reportSha256"] = hashlib.sha256(_canonical_bytes(report)).hexdigest()
    return report


def _bucket():
    endpoint = os.environ.get("OSS_ENDPOINT", "")
    bucket_name = os.environ.get("OSS_BUCKET", "")
    if endpoint != ALLOWED_OSS_ENDPOINT or not IDENTIFIER.fullmatch(bucket_name):
        raise RetrainingDatasetStoreError("RETRAINING_OSS_DESTINATION_INVALID")
    import oss2

    auth = oss2.Auth(
        os.environ["OSS_ACCESS_KEY_ID"],
        os.environ["OSS_ACCESS_KEY_SECRET"],
    )
    return oss2.Bucket(auth, endpoint, bucket_name)


def _metadata_hash(head) -> str | None:
    headers = getattr(head, "headers", {})
    return headers.get("x-oss-meta-sha256") or headers.get("X-Oss-Meta-Sha256")


def _upload_file(bucket, key: str, path: Path, sha256: str) -> str:
    if bucket.object_exists(key):
        head = bucket.head_object(key)
        if head.content_length != path.stat().st_size or _metadata_hash(head) != sha256:
            raise RetrainingDatasetStoreError("RETRAINING_OSS_OBJECT_CONFLICT")
        return "EXISTS"
    import oss2

    oss2.resumable_upload(
        bucket,
        key,
        str(path),
        headers={
            "x-oss-forbid-overwrite": "true",
            "x-oss-meta-sha256": sha256,
        },
    )
    return "UPLOADED"


def _upload_bytes(bucket, key: str, payload: bytes) -> str:
    sha256 = hashlib.sha256(payload).hexdigest()
    if bucket.object_exists(key):
        head = bucket.head_object(key)
        if head.content_length != len(payload) or _metadata_hash(head) != sha256:
            raise RetrainingDatasetStoreError("RETRAINING_OSS_OBJECT_CONFLICT")
        return "EXISTS"
    bucket.put_object(
        key,
        payload,
        headers={
            "x-oss-forbid-overwrite": "true",
            "x-oss-meta-sha256": sha256,
        },
    )
    return "UPLOADED"


def checkpoint_dataset(root: Path, *, scope: str, kind: str, dataset_id: str) -> dict:
    report = audit_dataset(root, scope=scope, kind=kind, dataset_id=dataset_id)
    spec = DATASET_SPECS[kind]
    prefix = _prefix(scope, kind, dataset_id)
    database_hash = report["databaseSha256"]
    bucket = _bucket()
    database_status = _upload_file(
        bucket,
        f"{prefix}/checkpoints/{database_hash}.sqlite3",
        root.resolve() / spec.database,
        database_hash,
    )
    manifest_status = "ABSENT"
    manifest = root.resolve() / "manifest.json"
    if manifest.exists():
        manifest_status = _upload_file(
            bucket,
            f"{prefix}/manifests/{database_hash}.json",
            manifest,
            report["manifestSha256"],
        )
    report_payload = json.dumps(
        report,
        ensure_ascii=False,
        sort_keys=True,
        indent=2,
    ).encode() + b"\n"
    audit_status = _upload_bytes(
        bucket,
        f"{prefix}/audits/{database_hash}.json",
        report_payload,
    )
    return {
        **report,
        "checkpointStatus": database_status,
        "manifestStatus": manifest_status,
        "auditStatus": audit_status,
    }


def _latest_checkpoint(objects, prefix: str):
    candidates = [
        item
        for item in objects
        if item.key.startswith(prefix)
        and item.key.endswith(".sqlite3")
        and SHA256.fullmatch(Path(item.key).stem)
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda item: (int(item.last_modified or 0), item.key))


def restore_dataset(root: Path, *, scope: str, kind: str, dataset_id: str) -> dict:
    spec = _validated_identity(scope, kind, dataset_id)
    prefix = _prefix(scope, kind, dataset_id)
    bucket = _bucket()
    import oss2

    latest = _latest_checkpoint(
        oss2.ObjectIterator(bucket, prefix=f"{prefix}/checkpoints/"),
        f"{prefix}/checkpoints/",
    )
    dataset_root = root.resolve()
    dataset_root.mkdir(parents=True, exist_ok=True)
    if latest is None:
        return {"status": "NOT_FOUND", "kind": kind, "datasetId": dataset_id}

    expected_hash = Path(latest.key).stem
    database = dataset_root / spec.database
    temporary = database.with_suffix(database.suffix + ".download")
    oss2.resumable_download(bucket, latest.key, str(temporary))
    actual_hash = _file_sha256(temporary)
    if actual_hash != expected_hash:
        temporary.unlink(missing_ok=True)
        raise RetrainingDatasetStoreError("RETRAINING_OSS_HASH_MISMATCH")
    os.replace(temporary, database)

    manifest_path = dataset_root / "manifest.json"
    manifest_key = f"{prefix}/manifests/{expected_hash}.json"
    if bucket.object_exists(manifest_key):
        payload = bucket.get_object(manifest_key).read()
        manifest = json.loads(payload)
        if (
            manifest.get("datasetId") != dataset_id
            or manifest.get("database") != spec.database
            or manifest.get("databaseSha256") != expected_hash
        ):
            raise RetrainingDatasetStoreError("RETRAINING_MANIFEST_MISMATCH")
        manifest_path.write_bytes(payload)
    else:
        manifest_path.unlink(missing_ok=True)
    report = audit_dataset(
        dataset_root,
        scope=scope,
        kind=kind,
        dataset_id=dataset_id,
    )
    return {"status": "RESTORED", **report}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["audit", "checkpoint", "restore"])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--scope", choices=["smoke", "full"], required=True)
    parser.add_argument("--kind", choices=sorted(DATASET_SPECS), required=True)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    options = {
        "scope": args.scope,
        "kind": args.kind,
        "dataset_id": args.dataset_id,
    }
    if args.command == "audit":
        result = audit_dataset(args.root, **options)
    elif args.command == "checkpoint":
        result = checkpoint_dataset(args.root, **options)
    else:
        result = restore_dataset(args.root, **options)
    rendered = json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
