import hashlib
import json

import joblib
import numpy as np
import pytest

from platform_app.modules.experiments.quant_model_bundle import (
    QuantBundleError,
    QuantModelBundle,
)


class _ProbabilityModel:
    def __init__(self, value):
        self.value = value

    def predict_proba(self, values):
        return np.asarray([[1 - self.value, self.value] for _ in values])


class _ValueModel:
    def __init__(self, value):
        self.value = value

    def predict(self, values):
        return np.asarray([self.value for _ in values])


def _bundle(tmp_path, *, release_status="UNAVAILABLE"):
    root = tmp_path / "bundle"
    root.mkdir()
    artifact = {
        "schemaVersion": "quant-model-bundle.v1",
        "baseFeatureNames": ["base"],
        "scenarioFeatureNames": ["base", "size"],
        "models": {
            "pFill": _ProbabilityModel(0.8),
            "pFullFill": _ProbabilityModel(0.6),
            "pWinGivenFill": _ProbabilityModel(0.55),
            "stopHazard": _ProbabilityModel(0.2),
            "expectedNetReturnGivenFill": _ValueModel(0.01),
            "q10": _ValueModel(0.03),
            "q50": _ValueModel(0.01),
            "q90": _ValueModel(0.02),
            "postProcessors": {
                "expectedNetReturnOffset": 0.001,
                "quantileOffsets": {"q10": -0.001, "q50": 0.002, "q90": 0.003},
                "quantileOrder": ["q10", "q50", "q90"],
                "quantileCrossingPolicy": "SORT_AFTER_CALIBRATION",
            },
        },
    }
    artifact_path = root / "models.joblib"
    joblib.dump(artifact, artifact_path)
    manifest = {
        "bundleId": "test-bundle",
        "schemaVersion": "quant-model-bundle.v1",
        "artifact": artifact_path.name,
        "artifactSha256": hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
        "baseFeatureNames": ["base"],
        "scenarioFeatureNames": ["base", "size"],
        "releaseStatus": release_status,
    }
    (root / "manifest.json").write_text(json.dumps(manifest))
    return root


def test_bundle_rejects_unreleased_model_by_default(tmp_path):
    with pytest.raises(QuantBundleError, match="QUANT_BUNDLE_NOT_RELEASED"):
        QuantModelBundle(_bundle(tmp_path))


def test_research_bundle_predicts_and_orders_calibrated_quantiles(tmp_path):
    bundle = QuantModelBundle(_bundle(tmp_path), require_ready=False)

    result = bundle.predict(
        base_features={"base": 1},
        scenario_features={"base": 1, "size": 2},
    )

    assert result == {
        "modelBundleId": "test-bundle",
        "pFill": 0.8,
        "pFullFill": 0.6,
        "pWinGivenFill": 0.55,
        "q10": 0.012,
        "q50": 0.023,
        "q90": 0.028999999999999998,
        "expectedNetReturnGivenFill": 0.011,
        "stopHazard": 0.2,
    }


def test_bundle_rejects_feature_contract_drift(tmp_path):
    bundle = QuantModelBundle(_bundle(tmp_path), require_ready=False)

    with pytest.raises(QuantBundleError, match="QUANT_FEATURE_CONTRACT_MISMATCH"):
        bundle.predict(
            base_features={"wrong": 1},
            scenario_features={"base": 1, "size": 2},
        )
