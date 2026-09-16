import hashlib
import json

import joblib
import numpy as np
import pytest

from platform_app.modules.experiments.ranking_model_bundle import (
    RankingBundleError,
    RankingModelBundle,
)


class _ValueModel:
    def __init__(self, value):
        self.value = value

    def predict(self, values):
        return np.asarray([self.value for _ in values])


def _bundle(tmp_path, *, release_status="UNAVAILABLE"):
    root = tmp_path / "ranking-bundle"
    root.mkdir()
    artifact = {
        "schemaVersion": "ranking-model-bundle.v1",
        "featureNames": ["return", "volatility"],
        "models": {
            "rank": _ValueModel(0.7),
            "expectedGrossReturn": _ValueModel(0.03),
        },
    }
    artifact_path = root / "models.joblib"
    joblib.dump(artifact, artifact_path)
    manifest = {
        "bundleId": "test-ranking-bundle",
        "schemaVersion": "ranking-model-bundle.v1",
        "artifact": artifact_path.name,
        "artifactSha256": hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
        "featureNames": artifact["featureNames"],
        "releaseStatus": release_status,
    }
    (root / "manifest.json").write_text(json.dumps(manifest))
    return root


def test_ranking_bundle_rejects_unreleased_model_by_default(tmp_path):
    with pytest.raises(
        RankingBundleError,
        match="RANKING_BUNDLE_NOT_RELEASED",
    ):
        RankingModelBundle(_bundle(tmp_path))


def test_ranking_bundle_predicts_verified_matrix_for_research(tmp_path):
    bundle = RankingModelBundle(_bundle(tmp_path), require_ready=False)

    result = bundle.predict_matrix(np.asarray([[0.1, 0.2], [0.3, 0.4]]))

    assert result["rankScore"].tolist() == [0.7, 0.7]
    assert result["expectedGrossReturn"].tolist() == [0.03, 0.03]


def test_ranking_bundle_rejects_feature_contract_drift(tmp_path):
    bundle = RankingModelBundle(_bundle(tmp_path), require_ready=False)

    with pytest.raises(
        RankingBundleError,
        match="RANKING_FEATURE_CONTRACT_MISMATCH",
    ):
        bundle.predict_matrix(np.asarray([[0.1]]))
