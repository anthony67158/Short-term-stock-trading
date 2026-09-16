"""Train and evaluate a versioned quantitative prediction bundle."""

import hashlib
import json
import math
import os
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import groupby
from pathlib import Path

import joblib
import numpy as np
import sklearn
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.frozen import FrozenEstimator
from sklearn.metrics import (
    brier_score_loss,
    mean_absolute_error,
    mean_pinball_loss,
    roc_auc_score,
)

MODEL_SCHEMA_VERSION = "quant-model-bundle.v1"
RANDOM_STATE = 97240
EMBARGO_SESSIONS = 5
BASE_FEATURE_NAMES = (
    "adjustedReturn5",
    "adjustedReturn20",
    "adjustedReturn60",
    "realizedVolatility20",
    "logMedianAmount20Cny",
    "rankWithinBoard",
    "boardMain",
    "boardChinext",
    "boardStar",
    "boardBeijing",
)
SCENARIO_FEATURE_NAMES = (
    *BASE_FEATURE_NAMES,
    "logTargetNotionalCny",
    "logTargetShares",
    "logTargetToMedianAmount",
)
ENRICHED_BASE_FEATURE_NAMES = (
    "adjustedReturn1",
    "adjustedReturn5",
    "adjustedReturn10",
    "adjustedReturn20",
    "adjustedReturn60",
    "realizedVolatility5",
    "realizedVolatility20",
    "realizedVolatility60",
    "drawdownFromHigh20",
    "distanceFromLow20",
    "logMedianAmount5Cny",
    "logMedianAmount20Cny",
    "logMedianAmount60Cny",
    "amountToMedian20",
    "meanRange20",
    "gap1",
    "closeLocation1",
    "logListingAgeDays",
    "boardMain",
    "boardChinext",
    "boardStar",
    "boardBeijing",
    "marketMeanReturn1",
    "marketMeanReturn20",
    "marketBreadth20",
    "marketMedianVolatility20",
    "boardRankReturn5",
    "boardRankReturn20",
    "boardRankReturn60",
    "boardRankVolatility20",
    "boardRankLiquidity20",
)
ENRICHED_SCENARIO_FEATURE_NAMES = (
    *ENRICHED_BASE_FEATURE_NAMES,
    "logTargetNotionalCny",
    "logTargetShares",
    "logTargetToMedianAmount",
)


class QuantModelError(ValueError):
    pass


@dataclass(frozen=True)
class TemporalSplit:
    train_end: int
    calibration_start: int
    calibration_end: int
    confirmation_start: int
    confirmation_end: int

    def masks(self, dates: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        return (
            dates <= self.train_end,
            (dates >= self.calibration_start) & (dates <= self.calibration_end),
            (dates >= self.confirmation_start) & (dates <= self.confirmation_end),
        )

    def as_dict(self) -> dict:
        return {
            "trainEnd": str(self.train_end),
            "calibrationStart": str(self.calibration_start),
            "calibrationEnd": str(self.calibration_end),
            "confirmationStart": str(self.confirmation_start),
            "confirmationEnd": str(self.confirmation_end),
            "embargoSessions": EMBARGO_SESSIONS,
        }


@dataclass
class QuantTrainingData:
    base_x: np.ndarray
    base_dates: np.ndarray
    base_boards: np.ndarray
    p_fill: np.ndarray
    stop_hazard: np.ndarray
    stop_available: np.ndarray
    scenario_x: np.ndarray
    scenario_dates: np.ndarray
    scenario_boards: np.ndarray
    p_full_fill: np.ndarray
    p_win: np.ndarray
    net_return: np.ndarray
    conditional_available: np.ndarray
    base_feature_names: tuple[str, ...] = BASE_FEATURE_NAMES
    scenario_feature_names: tuple[str, ...] = SCENARIO_FEATURE_NAMES


def temporal_split(
    dates: np.ndarray,
    *,
    train_fraction: float = 0.65,
    calibration_fraction: float = 0.15,
) -> TemporalSplit:
    unique = np.unique(dates)
    if len(unique) < 40:
        raise QuantModelError("MODEL_DATE_SUPPORT_INSUFFICIENT")
    train_index = max(0, int(len(unique) * train_fraction) - 1)
    calibration_start_index = train_index + 1 + EMBARGO_SESSIONS
    calibration_end_index = max(
        calibration_start_index,
        int(len(unique) * (train_fraction + calibration_fraction)) - 1,
    )
    confirmation_start_index = calibration_end_index + 1 + EMBARGO_SESSIONS
    if confirmation_start_index >= len(unique):
        raise QuantModelError("MODEL_CONFIRMATION_SUPPORT_INSUFFICIENT")
    return TemporalSplit(
        train_end=int(unique[train_index]),
        calibration_start=int(unique[calibration_start_index]),
        calibration_end=int(unique[calibration_end_index]),
        confirmation_start=int(unique[confirmation_start_index]),
        confirmation_end=int(unique[-1]),
    )


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _verified_database(root: Path, expected_schema: str) -> tuple[dict, Path]:
    manifest_path = root.resolve() / "manifest.json"
    if not manifest_path.is_file():
        raise QuantModelError("MODEL_INPUT_NOT_SEALED")
    try:
        manifest = json.loads(manifest_path.read_text())
        database = root.resolve() / manifest["database"]
    except (KeyError, json.JSONDecodeError, TypeError) as exc:
        raise QuantModelError("MODEL_INPUT_MANIFEST_INVALID") from exc
    if (
        manifest.get("schemaVersion") != expected_schema
        or not database.is_file()
        or _file_sha256(database) != manifest.get("databaseSha256")
    ):
        raise QuantModelError("MODEL_INPUT_HASH_MISMATCH")
    return manifest, database


def _base_features(row: sqlite3.Row, features: dict) -> list[float]:
    board = row["board"]
    return [
        float(features["adjustedReturn5"]),
        float(features["adjustedReturn20"]),
        float(features["adjustedReturn60"]),
        float(features["realizedVolatility20"]),
        math.log1p(float(features["medianAmount20Cny"])),
        float(row["rank_within_board"]),
        float(board == "MAIN"),
        float(board == "CHINEXT"),
        float(board == "STAR"),
        float(board == "BEIJING"),
    ]


def load_training_data(
    *,
    episode_dataset_root: Path,
    label_dataset_root: Path,
) -> tuple[QuantTrainingData, dict]:
    episode_manifest, episode_path = _verified_database(
        episode_dataset_root, "episode-dataset.v4"
    )
    label_manifest, label_path = _verified_database(
        label_dataset_root, "label-dataset.v2"
    )
    if label_manifest["episodeDatabaseSha256"] != episode_manifest["databaseSha256"]:
        raise QuantModelError("MODEL_EPISODE_LABEL_MISMATCH")

    label_uri = f"{label_path.resolve().as_uri()}?mode=ro&immutable=1"
    database = sqlite3.connect(label_uri, uri=True)
    database.row_factory = sqlite3.Row
    episode_uri = f"{episode_path.resolve().as_uri()}?mode=ro&immutable=1"
    database.execute("ATTACH DATABASE ? AS episodes", (episode_uri,))
    base_x = []
    base_dates = []
    base_boards = []
    p_fill = []
    stop_hazard = []
    stop_available = []
    scenario_x = []
    scenario_dates = []
    scenario_boards = []
    p_full_fill = []
    p_win = []
    net_return = []
    conditional_available = []
    board_codes = {"MAIN": 0, "CHINEXT": 1, "STAR": 2, "BEIJING": 3}
    current_episode = None
    rows = database.execute(
        "SELECT l.*, e.features_json, e.rank_within_board "
        "FROM episode_labels l JOIN episodes.candidate_episodes e "
        "ON e.episode_id = l.episode_id "
        "ORDER BY l.decision_date, l.episode_id, l.target_shares"
    )
    for row in rows:
        features = json.loads(row["features_json"])
        base = _base_features(row, features)
        decision_date = int(row["decision_date"])
        board_code = board_codes[row["board"]]
        if row["episode_id"] != current_episode:
            current_episode = row["episode_id"]
            base_x.append(base)
            base_dates.append(decision_date)
            base_boards.append(board_code)
            p_fill.append(row["p_fill_label"])
            available = row["stop_hazard_label"] is not None
            stop_available.append(available)
            stop_hazard.append(row["stop_hazard_label"] if available else 0)
        target_to_median = max(float(row["target_to_median_amount"]), 1e-12)
        scenario_x.append(
            [
                *base,
                math.log1p(float(row["target_notional_cny"])),
                math.log1p(row["target_shares"]),
                math.log(target_to_median),
            ]
        )
        scenario_dates.append(decision_date)
        scenario_boards.append(board_code)
        p_full_fill.append(row["p_full_fill_label"])
        available = row["net_return_given_fill"] is not None
        conditional_available.append(available)
        p_win.append(row["p_win_given_fill_label"] if available else 0)
        net_return.append(
            float(row["net_return_given_fill"]) if available else 0.0
        )
    database.close()
    data = QuantTrainingData(
        base_x=np.asarray(base_x, dtype=np.float32),
        base_dates=np.asarray(base_dates, dtype=np.int32),
        base_boards=np.asarray(base_boards, dtype=np.int8),
        p_fill=np.asarray(p_fill, dtype=np.int8),
        stop_hazard=np.asarray(stop_hazard, dtype=np.int8),
        stop_available=np.asarray(stop_available, dtype=bool),
        scenario_x=np.asarray(scenario_x, dtype=np.float32),
        scenario_dates=np.asarray(scenario_dates, dtype=np.int32),
        scenario_boards=np.asarray(scenario_boards, dtype=np.int8),
        p_full_fill=np.asarray(p_full_fill, dtype=np.int8),
        p_win=np.asarray(p_win, dtype=np.int8),
        net_return=np.asarray(net_return, dtype=np.float32),
        conditional_available=np.asarray(conditional_available, dtype=bool),
    )
    return data, {
        "episodeManifest": episode_manifest,
        "labelManifest": label_manifest,
    }


def _selected_ranking_features(
    database: sqlite3.Connection,
    *,
    expected_count: int,
) -> dict[tuple[str, str], list[float]]:
    from platform_app.modules.experiments.ranking_model_trainer import (
        RAW_COLUMNS,
        _date_features,
    )

    selected_by_date: dict[str, set[str]] = {}
    for row in database.execute(
        "SELECT DISTINCT decision_date, instrument_id FROM episode_labels "
        "ORDER BY decision_date, instrument_id"
    ):
        selected_by_date.setdefault(row["decision_date"], set()).add(
            row["instrument_id"]
        )
    if not selected_by_date:
        raise QuantModelError("MODEL_ENRICHED_SAMPLE_SUPPORT_EMPTY")
    features = {}
    columns = ", ".join((*RAW_COLUMNS, "forward_return_next_open_5"))
    rows = database.execute(
        f"SELECT instrument_id, decision_date, board, {columns} "
        "FROM ranking.ranking_samples WHERE decision_date BETWEEN ? AND ? "
        "ORDER BY decision_date, board, instrument_id",
        (min(selected_by_date), max(selected_by_date)),
    )
    for decision_date, date_rows in groupby(
        rows,
        key=lambda row: row["decision_date"],
    ):
        group_rows = list(date_rows)
        if decision_date not in selected_by_date:
            continue
        group_x, _target_rank = _date_features(group_rows)
        selected_instruments = selected_by_date[decision_date]
        for row, values in zip(group_rows, group_x, strict=True):
            if row["instrument_id"] in selected_instruments:
                features[(decision_date, row["instrument_id"])] = values.tolist()
    if len(features) != expected_count:
        raise QuantModelError("MODEL_ENRICHED_SAMPLE_COVERAGE_INCOMPLETE")
    return features


def load_enriched_training_data(
    *,
    episode_dataset_root: Path,
    label_dataset_root: Path,
    ranking_dataset_root: Path,
) -> tuple[QuantTrainingData, dict]:
    episode_manifest, _episode_path = _verified_database(
        episode_dataset_root, "episode-dataset.v4"
    )
    label_manifest, label_path = _verified_database(
        label_dataset_root, "label-dataset.v2"
    )
    ranking_manifest, ranking_path = _verified_database(
        ranking_dataset_root, "ranking-dataset.v1"
    )
    if (
        label_manifest["episodeDatabaseSha256"] != episode_manifest["databaseSha256"]
        or ranking_manifest["marketDatabaseSha256"]
        != episode_manifest["marketDatabaseSha256"]
    ):
        raise QuantModelError("MODEL_ENRICHED_LINEAGE_MISMATCH")

    label_uri = f"{label_path.resolve().as_uri()}?mode=ro&immutable=1"
    database = sqlite3.connect(label_uri, uri=True)
    database.row_factory = sqlite3.Row
    database.execute(
        "ATTACH DATABASE ? AS ranking",
        (f"{ranking_path.resolve().as_uri()}?mode=ro&immutable=1",),
    )
    ranking_features = _selected_ranking_features(
        database,
        expected_count=label_manifest["labels"]["episodes"],
    )
    base_x = []
    base_dates = []
    base_boards = []
    p_fill = []
    stop_hazard = []
    stop_available = []
    scenario_x = []
    scenario_dates = []
    scenario_boards = []
    p_full_fill = []
    p_win = []
    net_return = []
    conditional_available = []
    board_codes = {"MAIN": 0, "CHINEXT": 1, "STAR": 2, "BEIJING": 3}
    rows = database.execute(
        "SELECT l.* FROM episode_labels l "
        "ORDER BY l.decision_date, l.episode_id, l.target_shares"
    )
    current_episode = None
    for row in rows:
        decision_date = int(row["decision_date"])
        base = ranking_features[(row["decision_date"], row["instrument_id"])]
        board_code = board_codes[row["board"]]
        if row["episode_id"] != current_episode:
            current_episode = row["episode_id"]
            base_x.append(base)
            base_dates.append(decision_date)
            base_boards.append(board_code)
            p_fill.append(row["p_fill_label"])
            available = row["stop_hazard_label"] is not None
            stop_available.append(available)
            stop_hazard.append(row["stop_hazard_label"] if available else 0)
        target_to_median = max(float(row["target_to_median_amount"]), 1e-12)
        scenario_x.append(
            [
                *base,
                math.log1p(float(row["target_notional_cny"])),
                math.log1p(row["target_shares"]),
                math.log(target_to_median),
            ]
        )
        scenario_dates.append(decision_date)
        scenario_boards.append(board_code)
        p_full_fill.append(row["p_full_fill_label"])
        available = row["net_return_given_fill"] is not None
        conditional_available.append(available)
        p_win.append(row["p_win_given_fill_label"] if available else 0)
        net_return.append(
            float(row["net_return_given_fill"]) if available else 0.0
        )
    database.close()
    data = QuantTrainingData(
        base_x=np.asarray(base_x, dtype=np.float32),
        base_dates=np.asarray(base_dates, dtype=np.int32),
        base_boards=np.asarray(base_boards, dtype=np.int8),
        p_fill=np.asarray(p_fill, dtype=np.int8),
        stop_hazard=np.asarray(stop_hazard, dtype=np.int8),
        stop_available=np.asarray(stop_available, dtype=bool),
        scenario_x=np.asarray(scenario_x, dtype=np.float32),
        scenario_dates=np.asarray(scenario_dates, dtype=np.int32),
        scenario_boards=np.asarray(scenario_boards, dtype=np.int8),
        p_full_fill=np.asarray(p_full_fill, dtype=np.int8),
        p_win=np.asarray(p_win, dtype=np.int8),
        net_return=np.asarray(net_return, dtype=np.float32),
        conditional_available=np.asarray(conditional_available, dtype=bool),
        base_feature_names=ENRICHED_BASE_FEATURE_NAMES,
        scenario_feature_names=ENRICHED_SCENARIO_FEATURE_NAMES,
    )
    if len(data.base_x) != label_manifest["labels"]["episodes"]:
        raise QuantModelError("MODEL_ENRICHED_SAMPLE_COVERAGE_INCOMPLETE")
    return data, {
        "episodeManifest": episode_manifest,
        "labelManifest": label_manifest,
        "rankingManifest": ranking_manifest,
    }


def _classifier(max_iter: int, min_samples_leaf: int):
    return HistGradientBoostingClassifier(
        learning_rate=0.05,
        max_iter=max_iter,
        max_leaf_nodes=31,
        min_samples_leaf=min_samples_leaf,
        l2_regularization=1.0,
        early_stopping=False,
        random_state=RANDOM_STATE,
    )


def _regressor(
    *,
    max_iter: int,
    min_samples_leaf: int,
    loss: str,
    quantile: float | None = None,
):
    return HistGradientBoostingRegressor(
        loss=loss,
        quantile=quantile,
        learning_rate=0.05,
        max_iter=max_iter,
        max_leaf_nodes=31,
        min_samples_leaf=min_samples_leaf,
        l2_regularization=1.0,
        early_stopping=False,
        random_state=RANDOM_STATE,
    )


def _fit_calibrated(
    x: np.ndarray,
    y: np.ndarray,
    train: np.ndarray,
    calibration: np.ndarray,
    *,
    max_iter: int,
    min_samples_leaf: int,
):
    if len(np.unique(y[train])) != 2 or len(np.unique(y[calibration])) != 2:
        raise QuantModelError("MODEL_CLASS_SUPPORT_INSUFFICIENT")
    base = _classifier(max_iter, min_samples_leaf).fit(x[train], y[train])
    calibrated = CalibratedClassifierCV(
        FrozenEstimator(base),
        method="sigmoid",
    )
    return calibrated.fit(x[calibration], y[calibration])


def _classification_metrics(model, x, y) -> dict:
    probabilities = model.predict_proba(x)[:, 1]
    return {
        "samples": int(len(y)),
        "prevalence": float(np.mean(y)),
        "brier": float(brier_score_loss(y, probabilities)),
        "rocAuc": (
            float(roc_auc_score(y, probabilities))
            if len(np.unique(y)) == 2
            else None
        ),
    }


def train_quant_models(
    data: QuantTrainingData,
    *,
    max_iter: int = 120,
    min_samples_leaf: int = 100,
) -> tuple[dict, dict]:
    split = temporal_split(data.base_dates)
    base_train, base_calibration, base_confirmation = split.masks(data.base_dates)
    scenario_train, scenario_calibration, scenario_confirmation = split.masks(
        data.scenario_dates
    )
    conditional_train = scenario_train & data.conditional_available
    conditional_calibration = scenario_calibration & data.conditional_available
    conditional_confirmation = scenario_confirmation & data.conditional_available
    stop_train = base_train & data.stop_available
    stop_calibration = base_calibration & data.stop_available
    stop_confirmation = base_confirmation & data.stop_available

    models = {
        "pFill": _fit_calibrated(
            data.base_x,
            data.p_fill,
            base_train,
            base_calibration,
            max_iter=max_iter,
            min_samples_leaf=min_samples_leaf,
        ),
        "pFullFill": _fit_calibrated(
            data.scenario_x,
            data.p_full_fill,
            scenario_train,
            scenario_calibration,
            max_iter=max_iter,
            min_samples_leaf=min_samples_leaf,
        ),
        "pWinGivenFill": _fit_calibrated(
            data.scenario_x,
            data.p_win,
            conditional_train,
            conditional_calibration,
            max_iter=max_iter,
            min_samples_leaf=min_samples_leaf,
        ),
        "stopHazard": _fit_calibrated(
            data.base_x,
            data.stop_hazard,
            stop_train,
            stop_calibration,
            max_iter=max_iter,
            min_samples_leaf=min_samples_leaf,
        ),
    }
    models["expectedNetReturnGivenFill"] = _regressor(
        max_iter=max_iter,
        min_samples_leaf=min_samples_leaf,
        loss="squared_error",
    ).fit(data.scenario_x[conditional_train], data.net_return[conditional_train])
    for name, quantile in (("q10", 0.1), ("q50", 0.5), ("q90", 0.9)):
        models[name] = _regressor(
            max_iter=max_iter,
            min_samples_leaf=min_samples_leaf,
            loss="quantile",
            quantile=quantile,
        ).fit(data.scenario_x[conditional_train], data.net_return[conditional_train])

    calibration_x = data.scenario_x[conditional_calibration]
    calibration_y = data.net_return[conditional_calibration]
    quantile_offsets = {}
    for name, quantile in (("q10", 0.1), ("q50", 0.5), ("q90", 0.9)):
        residual = calibration_y - models[name].predict(calibration_x)
        quantile_offsets[name] = float(np.quantile(residual, quantile))
    expected_offset = float(
        np.mean(
            calibration_y
            - models["expectedNetReturnGivenFill"].predict(calibration_x)
        )
    )
    models["postProcessors"] = {
        "expectedNetReturnOffset": expected_offset,
        "quantileOffsets": quantile_offsets,
        "quantileOrder": ["q10", "q50", "q90"],
        "quantileCrossingPolicy": "SORT_AFTER_CALIBRATION",
    }
    conditional_x = data.scenario_x[conditional_confirmation]
    conditional_y = data.net_return[conditional_confirmation]
    raw_quantiles = np.column_stack(
        [
            models[name].predict(conditional_x) + quantile_offsets[name]
            for name in ("q10", "q50", "q90")
        ]
    )
    ordered_quantiles = np.sort(raw_quantiles, axis=1)
    quantile_predictions = {
        name: ordered_quantiles[:, index]
        for index, name in enumerate(("q10", "q50", "q90"))
    }
    expected = (
        models["expectedNetReturnGivenFill"].predict(conditional_x)
        + expected_offset
    )
    metrics = {
        "split": split.as_dict(),
        "pFill": _classification_metrics(
            models["pFill"],
            data.base_x[base_confirmation],
            data.p_fill[base_confirmation],
        ),
        "pFullFill": _classification_metrics(
            models["pFullFill"],
            data.scenario_x[scenario_confirmation],
            data.p_full_fill[scenario_confirmation],
        ),
        "pWinGivenFill": _classification_metrics(
            models["pWinGivenFill"],
            conditional_x,
            data.p_win[conditional_confirmation],
        ),
        "stopHazard": _classification_metrics(
            models["stopHazard"],
            data.base_x[stop_confirmation],
            data.stop_hazard[stop_confirmation],
        ),
        "expectedNetReturnGivenFill": {
            "samples": int(len(conditional_y)),
            "mae": float(mean_absolute_error(conditional_y, expected)),
        },
        "quantiles": {
            name: {
                "pinballLoss": float(
                    mean_pinball_loss(
                        conditional_y,
                        predictions,
                        alpha=quantile,
                    )
                )
            }
            for (name, quantile), predictions in zip(
                (("q10", 0.1), ("q50", 0.5), ("q90", 0.9)),
                quantile_predictions.values(),
                strict=True,
            )
        },
        "q10Q90Coverage": float(
            np.mean(
                (conditional_y >= quantile_predictions["q10"])
                & (conditional_y <= quantile_predictions["q90"])
            )
        ),
        "quantileCrossingRate": float(
            np.mean(
                (raw_quantiles[:, 0] > raw_quantiles[:, 1])
                | (raw_quantiles[:, 1] > raw_quantiles[:, 2])
            )
        ),
        "postProcessors": models["postProcessors"],
    }
    return models, metrics


def write_quant_bundle(
    *,
    output_root: Path,
    bundle_id: str,
    data: QuantTrainingData,
    lineage: dict,
    max_iter: int = 120,
    min_samples_leaf: int = 100,
) -> dict:
    root = output_root.resolve()
    manifest_path = root / "manifest.json"
    if manifest_path.exists():
        raise QuantModelError("MODEL_BUNDLE_ALREADY_EXISTS")
    root.mkdir(parents=True, exist_ok=True)
    models, metrics = train_quant_models(
        data,
        max_iter=max_iter,
        min_samples_leaf=min_samples_leaf,
    )
    artifact_path = root / "models.joblib"
    joblib.dump(
        {
            "schemaVersion": MODEL_SCHEMA_VERSION,
            "baseFeatureNames": data.base_feature_names,
            "scenarioFeatureNames": data.scenario_feature_names,
            "models": models,
        },
        artifact_path,
        compress=3,
    )
    artifact_hash = _file_sha256(artifact_path)
    manifest = {
        "bundleId": bundle_id,
        "schemaVersion": MODEL_SCHEMA_VERSION,
        "createdAt": datetime.now(UTC).isoformat(),
        "artifact": artifact_path.name,
        "artifactSha256": artifact_hash,
        "episodeDatasetId": lineage["episodeManifest"]["datasetId"],
        "episodeDatabaseSha256": lineage["episodeManifest"]["databaseSha256"],
        "labelDatasetId": lineage["labelManifest"]["datasetId"],
        "labelDatabaseSha256": lineage["labelManifest"]["databaseSha256"],
        "baseFeatureNames": data.base_feature_names,
        "scenarioFeatureNames": data.scenario_feature_names,
        "libraryVersions": {
            "numpy": np.__version__,
            "scikitLearn": sklearn.__version__,
            "joblib": joblib.__version__,
        },
        "metrics": metrics,
        "releaseStatus": "UNAVAILABLE",
        "releaseBlockers": [
            "FULL_UNIVERSE_BACKTEST_PENDING",
            "AGENT_BUNDLE_MISSING",
            "JOINT_ABLATION_PENDING",
        ],
    }
    if "rankingManifest" in lineage:
        manifest["rankingDatasetId"] = lineage["rankingManifest"]["datasetId"]
        manifest["rankingDatabaseSha256"] = lineage["rankingManifest"][
            "databaseSha256"
        ]
    temporary = manifest_path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    os.replace(temporary, manifest_path)
    return manifest
