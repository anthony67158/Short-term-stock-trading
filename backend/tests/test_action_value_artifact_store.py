import hashlib
import json

import pytest

from platform_app.modules.experiments import action_value_artifact_store as store
from platform_app.modules.experiments.action_value_experiment import SCHEMA_VERSION


def _experiment(root, *, passed=True):
    evaluation = root / "evaluation.json"
    evaluation.write_text("{}\n")
    artifacts = []
    for fold in range(1, 6):
        path = root / f"fold-{fold}.joblib"
        path.write_bytes(f"fold:{fold}".encode())
        artifacts.append(
            {
                "fold": fold,
                "path": path.name,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "releaseStatus": "UNAVAILABLE",
        "productionEligible": False,
        "evaluation": evaluation.name,
        "evaluationSha256": hashlib.sha256(evaluation.read_bytes()).hexdigest(),
        "foldArtifacts": artifacts,
        "gate": {"passed": passed},
    }
    (root / "manifest.json").write_text(json.dumps(manifest))
    return manifest


def test_upload_experiment_uses_gate_scoped_immutable_prefix(tmp_path, monkeypatch):
    _experiment(tmp_path, passed=True)
    uploaded = []
    receipts = []
    monkeypatch.setattr(store, "_bucket", lambda: object())
    monkeypatch.setattr(
        store,
        "_upload_file",
        lambda _bucket, key, path, sha256: uploaded.append(
            (key, path.name, sha256)
        )
        or "UPLOADED",
    )
    monkeypatch.setattr(
        store,
        "_upload_bytes",
        lambda _bucket, key, payload: receipts.append((key, payload))
        or "UPLOADED",
    )

    receipt = store.upload_experiment(tmp_path)

    assert receipt["status"] == "development-passed"
    assert receipt["productionPointerChanged"] is False
    assert all(receipt["manifestSha256"] in key for key, *_rest in uploaded)
    assert uploaded[-1][1] == "manifest.json"
    assert receipts[0][0].endswith("/receipt.json")
    assert b'"productionPointerChanged": false' in receipts[0][1]


def test_rejected_experiment_is_preserved_outside_passed_prefix(tmp_path, monkeypatch):
    _experiment(tmp_path, passed=False)
    keys = []
    monkeypatch.setattr(store, "_bucket", lambda: object())
    monkeypatch.setattr(
        store,
        "_upload_file",
        lambda _bucket, key, _path, _sha256: keys.append(key) or "UPLOADED",
    )
    monkeypatch.setattr(
        store,
        "_upload_bytes",
        lambda _bucket, key, _payload: keys.append(key) or "UPLOADED",
    )

    receipt = store.upload_experiment(tmp_path)

    assert receipt["status"] == "rejected"
    assert all("/experiments/rejected/" in key for key in keys)


def test_manifest_hash_or_release_state_mismatch_fails_closed(tmp_path):
    manifest = _experiment(tmp_path)
    (tmp_path / manifest["evaluation"]).write_text("tampered\n")
    with pytest.raises(
        store.ActionValueArtifactStoreError,
        match="ACTION_VALUE_ARTIFACT_MANIFEST_INVALID",
    ):
        store.upload_experiment(tmp_path)

    _experiment(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    manifest["productionEligible"] = True
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(
        store.ActionValueArtifactStoreError,
        match="ACTION_VALUE_ARTIFACT_MANIFEST_INVALID",
    ):
        store.upload_experiment(tmp_path)


def test_account_report_must_reference_exact_experiment_manifest(tmp_path, monkeypatch):
    _experiment(tmp_path)
    _manifest, manifest_hash, _files = store._manifest(tmp_path)
    report_path = tmp_path / "account.json"
    report_path.write_text(
        json.dumps(
            {
                "schemaVersion": "action-value-account-backtest.v1",
                "releaseStatus": "UNAVAILABLE",
                "productionEligible": False,
                "capacityGate": {"passed": True},
                "lineage": {
                    "actionValueExperimentManifestSha256": manifest_hash,
                },
            }
        )
    )
    keys = []
    monkeypatch.setattr(store, "_bucket", lambda: object())
    monkeypatch.setattr(
        store,
        "_upload_file",
        lambda _bucket, key, _path, _sha256: keys.append(key) or "UPLOADED",
    )

    receipt = store.upload_account_report(tmp_path, report_path)

    assert receipt["capacityGatePassed"] is True
    assert receipt["productionPointerChanged"] is False
    assert keys[0].startswith(
        f"{store.ROOT_PREFIX}/experiments/development-passed/{manifest_hash}/evidence/"
    )

    report = json.loads(report_path.read_text())
    report["lineage"]["actionValueExperimentManifestSha256"] = "0" * 64
    report_path.write_text(json.dumps(report))
    with pytest.raises(
        store.ActionValueArtifactStoreError,
        match="ACTION_VALUE_ACCOUNT_REPORT_INVALID",
    ):
        store.upload_account_report(tmp_path, report_path)
