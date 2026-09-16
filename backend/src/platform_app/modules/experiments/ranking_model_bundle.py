"""Verified full-universe ranking bundle loading and prediction."""

import hashlib
import json
from pathlib import Path

import joblib
import numpy as np

from platform_app.modules.experiments.ranking_model_trainer import (
    MODEL_SCHEMA_VERSION,
)


class RankingBundleError(ValueError):
    pass


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class RankingModelBundle:
    def __init__(self, root: Path, *, require_ready: bool = True):
        root = root.resolve()
        manifest_path = root / "manifest.json"
        if not manifest_path.is_file():
            raise RankingBundleError("RANKING_BUNDLE_MANIFEST_MISSING")
        try:
            self.manifest = json.loads(manifest_path.read_text())
            artifact_path = root / self.manifest["artifact"]
        except (KeyError, json.JSONDecodeError, TypeError) as exc:
            raise RankingBundleError("RANKING_BUNDLE_MANIFEST_INVALID") from exc
        if (
            self.manifest.get("schemaVersion") != MODEL_SCHEMA_VERSION
            or not artifact_path.is_file()
            or _file_sha256(artifact_path) != self.manifest.get("artifactSha256")
        ):
            raise RankingBundleError("RANKING_BUNDLE_HASH_MISMATCH")
        if require_ready and self.manifest.get("releaseStatus") != "READY":
            raise RankingBundleError("RANKING_BUNDLE_NOT_RELEASED")
        artifact = joblib.load(artifact_path)
        if (
            artifact.get("schemaVersion") != MODEL_SCHEMA_VERSION
            or tuple(artifact.get("featureNames", ()))
            != tuple(self.manifest.get("featureNames", ()))
        ):
            raise RankingBundleError("RANKING_BUNDLE_ARTIFACT_INVALID")
        self.feature_names = tuple(artifact["featureNames"])
        self.models = artifact["models"]
        if set(self.models) != {"rank", "expectedGrossReturn"}:
            raise RankingBundleError("RANKING_BUNDLE_MODELS_INCOMPLETE")

    def predict_matrix(self, values: np.ndarray) -> dict[str, np.ndarray]:
        matrix = np.asarray(values, dtype=np.float32)
        if (
            matrix.ndim != 2
            or matrix.shape[1] != len(self.feature_names)
            or not np.all(np.isfinite(matrix))
        ):
            raise RankingBundleError("RANKING_FEATURE_CONTRACT_MISMATCH")
        return {
            "rankScore": self.models["rank"].predict(matrix),
            "expectedGrossReturn": self.models["expectedGrossReturn"].predict(matrix),
        }
