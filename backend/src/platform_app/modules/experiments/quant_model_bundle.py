"""Verified quantitative bundle loading and prediction."""

import hashlib
import json
from pathlib import Path

import joblib
import numpy as np

from platform_app.modules.experiments.quant_model_trainer import MODEL_SCHEMA_VERSION


class QuantBundleError(ValueError):
    pass


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class QuantModelBundle:
    def __init__(self, root: Path, *, require_ready: bool = True):
        root = root.resolve()
        manifest_path = root / "manifest.json"
        if not manifest_path.is_file():
            raise QuantBundleError("QUANT_BUNDLE_MANIFEST_MISSING")
        try:
            self.manifest = json.loads(manifest_path.read_text())
            artifact_path = root / self.manifest["artifact"]
        except (KeyError, json.JSONDecodeError, TypeError) as exc:
            raise QuantBundleError("QUANT_BUNDLE_MANIFEST_INVALID") from exc
        if (
            self.manifest.get("schemaVersion") != MODEL_SCHEMA_VERSION
            or not artifact_path.is_file()
            or _file_sha256(artifact_path) != self.manifest.get("artifactSha256")
        ):
            raise QuantBundleError("QUANT_BUNDLE_HASH_MISMATCH")
        if require_ready and self.manifest.get("releaseStatus") != "READY":
            raise QuantBundleError("QUANT_BUNDLE_NOT_RELEASED")
        artifact = joblib.load(artifact_path)
        if (
            artifact.get("schemaVersion") != MODEL_SCHEMA_VERSION
            or tuple(artifact.get("baseFeatureNames", ()))
            != tuple(self.manifest.get("baseFeatureNames", ()))
            or tuple(artifact.get("scenarioFeatureNames", ()))
            != tuple(self.manifest.get("scenarioFeatureNames", ()))
        ):
            raise QuantBundleError("QUANT_BUNDLE_ARTIFACT_INVALID")
        self.base_feature_names = tuple(artifact["baseFeatureNames"])
        self.scenario_feature_names = tuple(artifact["scenarioFeatureNames"])
        self.models = artifact["models"]
        required_models = {
            "pFill",
            "pFullFill",
            "pWinGivenFill",
            "stopHazard",
            "expectedNetReturnGivenFill",
            "q10",
            "q50",
            "q90",
            "postProcessors",
        }
        if set(self.models) != required_models:
            raise QuantBundleError("QUANT_BUNDLE_MODELS_INCOMPLETE")

    @staticmethod
    def _vector(names: tuple[str, ...], values: dict) -> np.ndarray:
        if set(values) != set(names):
            raise QuantBundleError("QUANT_FEATURE_CONTRACT_MISMATCH")
        return QuantModelBundle._matrix(
            names,
            [[values[name] for name in names]],
        )

    @staticmethod
    def _matrix(names: tuple[str, ...], values) -> np.ndarray:
        matrix = np.asarray(values, dtype=np.float32)
        if (
            matrix.ndim != 2
            or matrix.shape[1] != len(names)
            or not np.all(np.isfinite(matrix))
        ):
            raise QuantBundleError("QUANT_FEATURE_NON_FINITE")
        return matrix

    def predict_matrix(self, *, base_values, scenario_values) -> dict[str, np.ndarray]:
        base = self._matrix(self.base_feature_names, base_values)
        scenario = self._matrix(self.scenario_feature_names, scenario_values)
        if len(base) != len(scenario):
            raise QuantBundleError("QUANT_FEATURE_ROW_COUNT_MISMATCH")
        post = self.models["postProcessors"]
        quantiles = np.sort(
            np.column_stack(
                [
                    self.models[name].predict(scenario)
                    + float(post["quantileOffsets"][name])
                    for name in ("q10", "q50", "q90")
                ]
            ),
            axis=1,
        )
        expected = self.models["expectedNetReturnGivenFill"].predict(
            scenario
        ) + float(post["expectedNetReturnOffset"])
        result = {
            "pFill": self.models["pFill"].predict_proba(base)[:, 1],
            "pFullFill": self.models["pFullFill"].predict_proba(scenario)[:, 1],
            "pWinGivenFill": self.models["pWinGivenFill"].predict_proba(scenario)[
                :, 1
            ],
            "q10": quantiles[:, 0],
            "q50": quantiles[:, 1],
            "q90": quantiles[:, 2],
            "expectedNetReturnGivenFill": expected,
            "stopHazard": self.models["stopHazard"].predict_proba(base)[:, 1],
        }
        if any(not np.all(np.isfinite(values)) for values in result.values()):
            raise QuantBundleError("QUANT_PREDICTION_NON_FINITE")
        return result

    def predict(self, *, base_features: dict, scenario_features: dict) -> dict:
        predictions = self.predict_matrix(
            base_values=self._vector(self.base_feature_names, base_features),
            scenario_values=self._vector(
                self.scenario_feature_names,
                scenario_features,
            ),
        )
        return {
            "modelBundleId": self.manifest["bundleId"],
            **{name: float(values[0]) for name, values in predictions.items()},
        }
