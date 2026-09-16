import hashlib
import json

import joblib
import numpy as np
import pytest

from platform_app.modules.experiments.position_action_model import (
    FEATURE_NAMES,
    MODEL_ACTIONS,
    PositionActionBundle,
    PositionActionTrainingData,
    train_position_action_models,
)
from platform_app.modules.experiments.quant_model_trainer import QuantModelError


class _ValueModel:
    def __init__(self, value):
        self.value = value

    def predict(self, values):
        return np.full(len(values), self.value)


def _training_data():
    rng = np.random.default_rng(97240)
    dates = np.repeat(np.arange(20200101, 20200161), 8)
    x = rng.normal(size=(len(dates), len(FEATURE_NAMES))).astype(np.float32)
    targets = np.column_stack(
        (
            x[:, 0] * 0.02 + x[:, 1] * 0.005,
            x[:, 2] * 0.01,
            -x[:, 0] * 0.02 + x[:, 3] * 0.005,
        )
    ).astype(np.float32)
    return PositionActionTrainingData(
        x=x,
        dates=dates.astype(np.int32),
        boards=np.tile(np.arange(4, dtype=np.int8), len(dates) // 4),
        episode_ids=np.asarray(
            [f"episode-{index // 2}".encode() for index in range(len(dates))],
            dtype="S64",
        ),
        targets=targets,
        sample_weights=np.ones(len(dates), dtype=np.float32),
    )


def test_position_action_models_report_regret_and_all_value_heads():
    models, metrics = train_position_action_models(
        _training_data(),
        max_iter=10,
        min_samples_leaf=10,
    )

    assert set(models) == {"ADD", "REDUCE", "EXIT", "postProcessors"}
    assert set(metrics["maeByAction"]) == {"ADD", "REDUCE", "EXIT"}
    assert metrics["confirmationSamples"] > 0
    assert metrics["meanRegret"] >= 0
    assert metrics["p90Regret"] >= 0
    assert set(metrics["byBoard"]) == {"MAIN", "CHINEXT", "STAR", "BEIJING"}


def test_position_bundle_is_fail_closed_and_predicts_action_values(tmp_path):
    root = tmp_path / "position-bundle"
    root.mkdir()
    artifact = {
        "schemaVersion": "position-action-model-bundle.v1",
        "featureNames": FEATURE_NAMES,
        "actions": MODEL_ACTIONS,
        "models": {
            "ADD": _ValueModel(0.02),
            "REDUCE": _ValueModel(-0.01),
            "EXIT": _ValueModel(0.01),
            "postProcessors": {
                "actionOffsets": {"ADD": 0.001, "REDUCE": 0.0, "EXIT": 0.0}
            },
        },
    }
    artifact_path = root / "models.joblib"
    joblib.dump(artifact, artifact_path)
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "bundleId": "position-v1",
                "schemaVersion": artifact["schemaVersion"],
                "artifact": artifact_path.name,
                "artifactSha256": hashlib.sha256(
                    artifact_path.read_bytes()
                ).hexdigest(),
                "releaseStatus": "UNAVAILABLE",
            }
        )
    )

    with pytest.raises(QuantModelError, match="POSITION_BUNDLE_NOT_RELEASED"):
        PositionActionBundle(root)
    result = PositionActionBundle(root, require_ready=False).predict_matrix(
        np.zeros((2, len(FEATURE_NAMES)))
    )
    assert result["chosenAction"].tolist() == ["ADD", "ADD"]
    assert result["deltaReturnVsHold"]["ADD"].tolist() == [0.021, 0.021]
