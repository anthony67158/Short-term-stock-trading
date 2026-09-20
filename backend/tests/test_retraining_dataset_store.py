import io
import json
import sqlite3
import sys
from types import SimpleNamespace

import pytest

from platform_app.modules.experiments import retraining_dataset_store as store


def _market_dataset(root, dataset_id="action-value-smoke-market-v1"):
    root.mkdir()
    database = root / "market.sqlite3"
    connection = sqlite3.connect(database)
    connection.executescript(
        """
        CREATE TABLE dataset_metadata (
            singleton INTEGER PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            schema_version TEXT NOT NULL
        );
        CREATE TABLE sample_rows (value TEXT NOT NULL);
        """
    )
    connection.execute(
        "INSERT INTO dataset_metadata VALUES (1, ?, 'market-dataset.v4')",
        (dataset_id,),
    )
    connection.executemany(
        "INSERT INTO sample_rows VALUES (?)",
        [("first",), ("second",)],
    )
    connection.commit()
    connection.close()
    return database


class FakeBucket:
    def __init__(self):
        self.objects = {}
        self.metadata = {}
        self.modified = {}
        self.clock = 0

    def object_exists(self, key):
        return key in self.objects

    def head_object(self, key):
        return SimpleNamespace(
            content_length=len(self.objects[key]),
            headers=self.metadata[key],
        )

    def put_object(self, key, payload, headers=None):
        self.clock += 1
        self.objects[key] = bytes(payload)
        self.metadata[key] = dict(headers or {})
        self.modified[key] = self.clock

    def get_object(self, key):
        return io.BytesIO(self.objects[key])


class FakeOss2:
    def __init__(self, bucket):
        self.bucket = bucket

    def ObjectIterator(self, bucket, prefix):
        assert bucket is self.bucket
        return [
            SimpleNamespace(
                key=key,
                last_modified=self.bucket.modified[key],
            )
            for key in sorted(self.bucket.objects)
            if key.startswith(prefix)
        ]

    def resumable_upload(self, bucket, key, filename, headers=None):
        assert bucket is self.bucket
        bucket.put_object(key, open(filename, "rb").read(), headers=headers)

    def resumable_download(self, bucket, key, filename):
        assert bucket is self.bucket
        with open(filename, "wb") as stream:
            stream.write(bucket.objects[key])


def test_audit_validates_identity_integrity_and_sealed_manifest(tmp_path):
    root = tmp_path / "market"
    _market_dataset(root)
    unsealed = store.audit_dataset(
        root,
        scope="smoke",
        kind="market",
        dataset_id="action-value-smoke-market-v1",
    )
    assert unsealed["sqliteIntegrity"] == "ok"
    assert unsealed["tables"]["sample_rows"] == 2
    assert unsealed["sealed"] is False

    (root / "manifest.json").write_text(
        json.dumps(
            {
                "datasetId": unsealed["datasetId"],
                "database": "market.sqlite3",
                "databaseSha256": unsealed["databaseSha256"],
            }
        )
    )
    sealed = store.audit_dataset(
        root,
        scope="smoke",
        kind="market",
        dataset_id="action-value-smoke-market-v1",
    )
    assert sealed["sealed"] is True
    assert len(sealed["manifestSha256"]) == 64
    assert len(sealed["reportSha256"]) == 64


def test_audit_rejects_manifest_or_dataset_identity_mismatch(tmp_path):
    root = tmp_path / "market"
    _market_dataset(root)
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "datasetId": "wrong-dataset",
                "database": "market.sqlite3",
                "databaseSha256": "0" * 64,
            }
        )
    )
    with pytest.raises(store.RetrainingDatasetStoreError, match="MANIFEST_MISMATCH"):
        store.audit_dataset(
            root,
            scope="smoke",
            kind="market",
            dataset_id="action-value-smoke-market-v1",
        )
    with pytest.raises(store.RetrainingDatasetStoreError, match="IDENTITY_MISMATCH"):
        store.audit_dataset(
            root,
            scope="smoke",
            kind="market",
            dataset_id="different-market-v1",
        )


def test_checkpoint_is_immutable_and_restore_revalidates_hash(tmp_path, monkeypatch):
    source = tmp_path / "source"
    _market_dataset(source)
    initial = store.audit_dataset(
        source,
        scope="smoke",
        kind="market",
        dataset_id="action-value-smoke-market-v1",
    )

    bucket = FakeBucket()
    fake_oss2 = FakeOss2(bucket)
    monkeypatch.setattr(store, "_bucket", lambda: bucket)
    monkeypatch.setitem(sys.modules, "oss2", fake_oss2)

    unsealed = store.checkpoint_dataset(
        source,
        scope="smoke",
        kind="market",
        dataset_id="action-value-smoke-market-v1",
    )
    assert unsealed["checkpointStatus"] == "UPLOADED"
    assert unsealed["manifestStatus"] == "ABSENT"

    (source / "manifest.json").write_text(
        json.dumps(
            {
                "datasetId": initial["datasetId"],
                "database": initial["database"],
                "databaseSha256": initial["databaseSha256"],
            }
        )
    )
    sealed = store.checkpoint_dataset(
        source,
        scope="smoke",
        kind="market",
        dataset_id="action-value-smoke-market-v1",
    )
    repeated = store.checkpoint_dataset(
        source,
        scope="smoke",
        kind="market",
        dataset_id="action-value-smoke-market-v1",
    )
    assert sealed["checkpointStatus"] == "EXISTS"
    assert sealed["manifestStatus"] == "UPLOADED"
    assert sealed["auditStatus"] == "UPLOADED"
    assert sealed["reportSha256"] != unsealed["reportSha256"]
    assert repeated["checkpointStatus"] == "EXISTS"
    assert repeated["manifestStatus"] == "EXISTS"
    assert repeated["auditStatus"] == "EXISTS"
    assert sum("/audits/" in key for key in bucket.objects) == 2

    restored_root = tmp_path / "restored"
    restored = store.restore_dataset(
        restored_root,
        scope="smoke",
        kind="market",
        dataset_id="action-value-smoke-market-v1",
    )
    assert restored["status"] == "RESTORED"
    assert restored["databaseSha256"] == sealed["databaseSha256"]
    assert (restored_root / "manifest.json").is_file()

    checkpoint_key = next(
        key for key in bucket.objects if "/checkpoints/" in key
    )
    bucket.objects[checkpoint_key] += b"corruption"
    with pytest.raises(store.RetrainingDatasetStoreError, match="OSS_HASH_MISMATCH"):
        store.restore_dataset(
            tmp_path / "corrupt",
            scope="smoke",
            kind="market",
            dataset_id="action-value-smoke-market-v1",
        )


def test_scope_kind_and_dataset_id_are_closed_inputs():
    for options in (
        {"scope": "preview", "kind": "market", "dataset_id": "valid-id"},
        {"scope": "smoke", "kind": "model", "dataset_id": "valid-id"},
        {"scope": "smoke", "kind": "market", "dataset_id": "../escape"},
    ):
        with pytest.raises(store.RetrainingDatasetStoreError):
            store._validated_identity(**options)
