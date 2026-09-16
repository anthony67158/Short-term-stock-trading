"""Train and verify paired counterfactual position-action value models."""

import hashlib
import json
import math
import os
import sqlite3
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import joblib
import numpy as np
import sklearn
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error

from platform_app.modules.experiments.quant_model_trainer import (
    RANDOM_STATE,
    QuantModelError,
    _selected_ranking_features,
    temporal_split,
)
from platform_app.modules.experiments.ranking_model_trainer import (
    MODEL_FEATURE_NAMES,
)

MODEL_SCHEMA_VERSION = "position-action-model-bundle.v1"
ACTIONS = ("HOLD", "ADD", "REDUCE", "EXIT")
MODEL_ACTIONS = ("ADD", "REDUCE", "EXIT")
STATE_FEATURE_NAMES = (
    "logCurrentShares",
    "logCurrentNotionalCny",
    "logCurrentToMedianAmount",
    "actionCapacityToCurrentShares",
)
FEATURE_NAMES = (*MODEL_FEATURE_NAMES, *STATE_FEATURE_NAMES)
BOARD_CODES = {"MAIN": 0, "CHINEXT": 1, "STAR": 2, "BEIJING": 3}


@dataclass
class PositionActionTrainingData:
    x: np.ndarray
    dates: np.ndarray
    boards: np.ndarray
    episode_ids: np.ndarray
    targets: np.ndarray
    sample_weights: np.ndarray


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _verified_database(root: Path, expected_schema: str) -> tuple[dict, Path]:
    manifest_path = root.resolve() / "manifest.json"
    if not manifest_path.is_file():
        raise QuantModelError("POSITION_MODEL_INPUT_NOT_SEALED")
    manifest = json.loads(manifest_path.read_text())
    database = root.resolve() / manifest["database"]
    if (
        manifest.get("schemaVersion") != expected_schema
        or not database.is_file()
        or _file_sha256(database) != manifest.get("databaseSha256")
    ):
        raise QuantModelError("POSITION_MODEL_INPUT_INVALID")
    return manifest, database


def load_position_action_training_data(
    *,
    position_dataset_root: Path,
    ranking_dataset_root: Path,
) -> tuple[PositionActionTrainingData, dict]:
    position_manifest, position_path = _verified_database(
        position_dataset_root,
        "position-action-dataset.v1",
    )
    ranking_manifest, ranking_path = _verified_database(
        ranking_dataset_root,
        "ranking-dataset.v1",
    )
    if (
        position_manifest["marketDatabaseSha256"]
        != ranking_manifest["marketDatabaseSha256"]
    ):
        raise QuantModelError("POSITION_MODEL_LINEAGE_MISMATCH")
    database = sqlite3.connect(
        f"{position_path.resolve().as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    database.row_factory = sqlite3.Row
    database.execute(
        "ATTACH DATABASE ? AS ranking",
        (f"{ranking_path.resolve().as_uri()}?mode=ro&immutable=1",),
    )
    database.execute(
        "CREATE TEMP VIEW episode_labels AS "
        "SELECT decision_date,instrument_id FROM position_action_labels"
    )
    distinct_states = database.execute(
        "SELECT COUNT(*) FROM (SELECT DISTINCT decision_date,instrument_id "
        "FROM position_action_labels)"
    ).fetchone()[0]
    ranking_features = _selected_ranking_features(
        database,
        expected_count=distinct_states,
    )
    rows = database.execute(
        "SELECT p.*,COUNT(*) OVER (PARTITION BY episode_id) AS episode_scenarios "
        "FROM position_action_labels p "
        "ORDER BY decision_date,episode_id,current_shares"
    )
    count = position_manifest["labels"]
    x = np.empty((count, len(FEATURE_NAMES)), dtype=np.float32)
    dates = np.empty(count, dtype=np.int32)
    boards = np.empty(count, dtype=np.int8)
    episode_ids = np.empty(count, dtype="S64")
    targets = np.empty((count, len(MODEL_ACTIONS)), dtype=np.float32)
    sample_weights = np.empty(count, dtype=np.float32)
    for index, row in enumerate(rows):
        base = ranking_features[(row["decision_date"], row["instrument_id"])]
        shares = row["current_shares"]
        current_notional = float(row["snapshot_price"]) * shares
        median_amount = math.expm1(base[11])
        x[index] = [
            *base,
            math.log1p(shares),
            math.log1p(current_notional),
            math.log(max(current_notional / median_amount, 1e-12)),
            row["action_capacity_shares"] / shares,
        ]
        dates[index] = int(row["decision_date"])
        boards[index] = BOARD_CODES[row["board"]]
        episode_ids[index] = row["episode_id"].encode()
        targets[index] = [
            float(row["add_delta_return"]),
            float(row["reduce_delta_return"]),
            float(row["exit_delta_return"]),
        ]
        sample_weights[index] = 1 / row["episode_scenarios"]
    database.close()
    if index + 1 != count:
        raise QuantModelError("POSITION_MODEL_SAMPLE_COUNT_MISMATCH")
    return (
        PositionActionTrainingData(
            x=x,
            dates=dates,
            boards=boards,
            episode_ids=episode_ids,
            targets=targets,
            sample_weights=sample_weights,
        ),
        {
            "positionManifest": position_manifest,
            "rankingManifest": ranking_manifest,
        },
    )


def _metrics(
    data: PositionActionTrainingData,
    predictions: np.ndarray,
    confirmation: np.ndarray,
) -> dict:
    actual = data.targets[confirmation]
    predicted = predictions[confirmation]
    actual_values = np.column_stack((np.zeros(len(actual)), actual))
    predicted_values = np.column_stack((np.zeros(len(predicted)), predicted))
    chosen = np.argmax(predicted_values, axis=1)
    best = np.max(actual_values, axis=1)
    chosen_actual = actual_values[np.arange(len(actual_values)), chosen]
    regrets = best - chosen_actual
    by_board = {}
    confirmation_boards = data.boards[confirmation]
    for board, code in BOARD_CODES.items():
        mask = confirmation_boards == code
        by_board[board] = {
            "samples": int(np.sum(mask)),
            "meanRegret": float(np.mean(regrets[mask])) if np.any(mask) else None,
            "meanChosenDeltaVsHold": (
                float(np.mean(chosen_actual[mask])) if np.any(mask) else None
            ),
        }
    return {
        "confirmationSamples": int(len(actual)),
        "maeByAction": {
            action: float(mean_absolute_error(actual[:, index], predicted[:, index]))
            for index, action in enumerate(MODEL_ACTIONS)
        },
        "meanRegret": float(np.mean(regrets)),
        "p90Regret": float(np.quantile(regrets, 0.9)),
        "meanChosenDeltaVsHold": float(np.mean(chosen_actual)),
        "positiveChosenDeltaRate": float(np.mean(chosen_actual > 0)),
        "chosenActions": dict(
            sorted(Counter(ACTIONS[index] for index in chosen).items())
        ),
        "actualBestActions": dict(
            sorted(
                Counter(
                    ACTIONS[index] for index in np.argmax(actual_values, axis=1)
                ).items()
            )
        ),
        "byBoard": by_board,
    }


def train_position_action_models(
    data: PositionActionTrainingData,
    *,
    max_iter: int = 120,
    min_samples_leaf: int = 200,
) -> tuple[dict, dict]:
    split = temporal_split(data.dates)
    train, calibration, confirmation = split.masks(data.dates)
    models = {}
    offsets = {}
    predictions = np.empty_like(data.targets)
    for index, action in enumerate(MODEL_ACTIONS):
        model = HistGradientBoostingRegressor(
            loss="squared_error",
            learning_rate=0.05,
            max_iter=max_iter,
            max_leaf_nodes=31,
            min_samples_leaf=min_samples_leaf,
            l2_regularization=1.0,
            early_stopping=False,
            random_state=RANDOM_STATE,
        ).fit(
            data.x[train],
            data.targets[train, index],
            sample_weight=data.sample_weights[train],
        )
        offset = float(
            np.average(
                data.targets[calibration, index]
                - model.predict(data.x[calibration]),
                weights=data.sample_weights[calibration],
            )
        )
        models[action] = model
        offsets[action] = offset
        predictions[:, index] = model.predict(data.x) + offset
    models["postProcessors"] = {"actionOffsets": offsets}
    metrics = {
        "split": split.as_dict(),
        **_metrics(data, predictions, confirmation),
        "postProcessors": models["postProcessors"],
    }
    return models, metrics


def write_position_action_bundle(
    *,
    output_root: Path,
    bundle_id: str,
    data: PositionActionTrainingData,
    lineage: dict,
    max_iter: int = 120,
) -> dict:
    root = output_root.resolve()
    manifest_path = root / "manifest.json"
    if manifest_path.exists():
        raise QuantModelError("POSITION_MODEL_BUNDLE_ALREADY_EXISTS")
    root.mkdir(parents=True, exist_ok=True)
    models, metrics = train_position_action_models(data, max_iter=max_iter)
    artifact_path = root / "models.joblib"
    joblib.dump(
        {
            "schemaVersion": MODEL_SCHEMA_VERSION,
            "featureNames": FEATURE_NAMES,
            "actions": MODEL_ACTIONS,
            "models": models,
        },
        artifact_path,
        compress=3,
    )
    position_manifest = lineage["positionManifest"]
    ranking_manifest = lineage["rankingManifest"]
    blockers = [
        "POSITION_ACCOUNT_REPLAY_PENDING",
        "PROSPECTIVE_AGENT_SAMPLE_SUPPORT_INSUFFICIENT",
        "JOINT_POSITION_ABLATION_PENDING",
        "REDUCE_ACTION_SUPPORT_LOW",
    ]
    if metrics["meanChosenDeltaVsHold"] <= 0:
        blockers.insert(0, "POSITION_VALUE_MODEL_NO_POSITIVE_LIFT")
    if any(
        values["meanChosenDeltaVsHold"] is not None
        and values["meanChosenDeltaVsHold"] <= 0
        for values in metrics["byBoard"].values()
    ):
        blockers.insert(0, "POSITION_BOARD_LIFT_NOT_POSITIVE")
    manifest = {
        "bundleId": bundle_id,
        "schemaVersion": MODEL_SCHEMA_VERSION,
        "createdAt": datetime.now(UTC).isoformat(),
        "artifact": artifact_path.name,
        "artifactSha256": _file_sha256(artifact_path),
        "positionDatasetId": position_manifest["datasetId"],
        "positionDatabaseSha256": position_manifest["databaseSha256"],
        "rankingDatasetId": ranking_manifest["datasetId"],
        "rankingDatabaseSha256": ranking_manifest["databaseSha256"],
        "featureNames": FEATURE_NAMES,
        "actions": MODEL_ACTIONS,
        "libraryVersions": {
            "numpy": np.__version__,
            "scikitLearn": sklearn.__version__,
            "joblib": joblib.__version__,
        },
        "metrics": metrics,
        "releaseStatus": "UNAVAILABLE",
        "releaseBlockers": blockers,
    }
    temporary = manifest_path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    os.replace(temporary, manifest_path)
    return manifest


class PositionActionBundle:
    def __init__(self, root: Path, *, require_ready: bool = True):
        manifest_path = root.resolve() / "manifest.json"
        if not manifest_path.is_file():
            raise QuantModelError("POSITION_BUNDLE_MANIFEST_MISSING")
        self.manifest = json.loads(manifest_path.read_text())
        artifact_path = root.resolve() / self.manifest.get("artifact", "")
        if (
            self.manifest.get("schemaVersion") != MODEL_SCHEMA_VERSION
            or not artifact_path.is_file()
            or _file_sha256(artifact_path) != self.manifest.get("artifactSha256")
        ):
            raise QuantModelError("POSITION_BUNDLE_HASH_MISMATCH")
        if require_ready and self.manifest.get("releaseStatus") != "READY":
            raise QuantModelError("POSITION_BUNDLE_NOT_RELEASED")
        artifact = joblib.load(artifact_path)
        if (
            artifact.get("schemaVersion") != MODEL_SCHEMA_VERSION
            or tuple(artifact.get("featureNames", ())) != FEATURE_NAMES
            or tuple(artifact.get("actions", ())) != MODEL_ACTIONS
            or set(artifact.get("models", ()))
            != {*MODEL_ACTIONS, "postProcessors"}
        ):
            raise QuantModelError("POSITION_BUNDLE_ARTIFACT_INVALID")
        self.models = artifact["models"]

    def predict_matrix(self, values) -> dict:
        matrix = np.asarray(values, dtype=np.float32)
        if (
            matrix.ndim != 2
            or matrix.shape[1] != len(FEATURE_NAMES)
            or not np.all(np.isfinite(matrix))
        ):
            raise QuantModelError("POSITION_FEATURE_CONTRACT_MISMATCH")
        offsets = self.models["postProcessors"]["actionOffsets"]
        deltas = {
            "HOLD": np.zeros(len(matrix), dtype=np.float64),
            **{
                action: self.models[action].predict(matrix) + offsets[action]
                for action in MODEL_ACTIONS
            },
        }
        stacked = np.column_stack([deltas[action] for action in ACTIONS])
        return {
            "deltaReturnVsHold": deltas,
            "chosenAction": np.asarray(ACTIONS)[np.argmax(stacked, axis=1)],
        }
