"""Reproducible probabilistic tree baselines on frozen foundation folds."""

import argparse
import fcntl
import gc
import hashlib
import json
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import catboost
import joblib
import lightgbm
import numpy as np
import sklearn
import xgboost
from catboost import CatBoostClassifier, CatBoostRegressor
from lightgbm import LGBMClassifier, LGBMRegressor
from scipy.stats import rankdata
from sklearn.metrics import log_loss, mean_pinball_loss
from xgboost import XGBClassifier, XGBRegressor

from platform_app.modules.experiments.foundation_return_contract import (
    DEFAULT_QUANTILES,
    experiment_config_sha256,
    experiment_id,
    load_frozen_experiment,
)
from platform_app.modules.experiments.foundation_return_dataset import (
    verify_foundation_return_dataset,
)
from platform_app.modules.experiments.foundation_sampling_dataset import (
    verify_foundation_sampling_dataset,
)
from platform_app.modules.experiments.ranking_model_trainer import (
    BOARD_CODES,
    GLOBAL_PERCENTILE_TARGET,
    MODEL_FEATURE_NAMES,
    RAW_COLUMNS,
    _date_features,
    _verified_ranking_database,
)

SCHEMA_VERSION = "foundation-probabilistic-baselines.v1"
REFERENCE_NOTIONAL_CNY = 100_000.0
MARKET_EXIT_SLIPPAGE_RATE = 0.0005
VALID_BOARDS = ("MAIN", "CHINEXT", "STAR", "BEIJING")
BASELINE_SEED = 20260917
DEFAULT_ITERATIONS = 120
CATBOOST_FAMILY = "catboost-multiquantile-v1"
XGBOOST_FAMILY = "xgboost-quantile-v1"
LIGHTGBM_FAMILY = "lightgbm-quantile-v1"
HISTORICAL_FAMILY = "historical-distribution-v1"
MODEL_FAMILIES = (
    HISTORICAL_FAMILY,
    CATBOOST_FAMILY,
    XGBOOST_FAMILY,
    LIGHTGBM_FAMILY,
)
PARTITION_RANGES = {
    "train": ("trainStart", "trainEnd", "trainSelected"),
    "probabilityCalibration": (
        "probabilityCalibrationStart",
        "probabilityCalibrationEnd",
        "probabilityCalibrationRows",
    ),
    "conformalCalibration": (
        "conformalCalibrationStart",
        "conformalCalibrationEnd",
        "conformalCalibrationRows",
    ),
    "test": ("testStart", "testEnd", "testRows"),
}
RANKING_COLUMNS = (
    "instrument_id",
    "decision_date",
    "board",
    "execution_date",
    "terminal_date",
    *RAW_COLUMNS,
    "forward_return_next_open_5",
)


class ProbabilisticBaselineError(ValueError):
    pass


@dataclass(frozen=True)
class BaselinePartition:
    x: np.ndarray
    dates: np.ndarray
    boards: np.ndarray
    instruments: np.ndarray
    target_return: np.ndarray
    direction: np.ndarray
    sample_weight: np.ndarray

    def __post_init__(self) -> None:
        lengths = {
            len(self.x),
            len(self.dates),
            len(self.boards),
            len(self.instruments),
            len(self.target_return),
            len(self.direction),
            len(self.sample_weight),
        }
        if lengths != {len(self.x)} or len(self.x) == 0:
            raise ProbabilisticBaselineError(
                "PROBABILISTIC_BASELINE_PARTITION_INVALID",
            )


@dataclass
class BaselineModelBundle:
    family: str
    classifier: Any
    quantile_model: Any
    quantiles: tuple[float, ...] = DEFAULT_QUANTILES

    def predict(self, x: np.ndarray) -> dict[str, np.ndarray]:
        probability = np.asarray(
            self.classifier.predict_proba(x)[:, 1],
            dtype=np.float32,
        )
        if isinstance(self.quantile_model, tuple):
            raw_quantiles = np.column_stack(
                [model.predict(x) for model in self.quantile_model],
            ).astype(np.float32)
        else:
            raw_quantiles = np.asarray(
                self.quantile_model.predict(x),
                dtype=np.float32,
            )
        if raw_quantiles.ndim == 1:
            raw_quantiles = raw_quantiles.reshape(-1, 1)
        if raw_quantiles.shape != (len(x), len(self.quantiles)):
            raise ProbabilisticBaselineError(
                "PROBABILISTIC_BASELINE_PREDICTION_SHAPE_INVALID",
            )
        ordered = np.sort(raw_quantiles, axis=1)
        result = {"pWin": np.clip(probability, 0.0, 1.0)}
        result.update(
            {
                f"q{round(alpha * 100):02d}": ordered[:, index]
                for index, alpha in enumerate(self.quantiles)
            }
        )
        return result


@dataclass(frozen=True)
class HistoricalBaselineModel:
    probability: float
    quantile_values: tuple[float, ...]
    family: str = HISTORICAL_FAMILY
    quantiles: tuple[float, ...] = DEFAULT_QUANTILES

    def predict(self, x: np.ndarray) -> dict[str, np.ndarray]:
        predictions = {
            "pWin": np.full(len(x), self.probability, dtype=np.float32),
        }
        predictions.update(
            {
                f"q{round(alpha * 100):02d}": np.full(
                    len(x),
                    value,
                    dtype=np.float32,
                )
                for alpha, value in zip(
                    self.quantiles,
                    self.quantile_values,
                    strict=True,
                )
            }
        )
        return predictions


def fit_historical_baseline(
    training: BaselinePartition,
) -> HistoricalBaselineModel:
    return HistoricalBaselineModel(
        probability=float(
            np.average(
                training.direction,
                weights=training.sample_weight,
            )
        ),
        quantile_values=tuple(
            float(value)
            for value in weighted_quantiles(
                training.target_return,
                sample_weight=training.sample_weight,
            )
        ),
    )


def fit_catboost_baseline(
    training: BaselinePartition,
    *,
    iterations: int = DEFAULT_ITERATIONS,
    threads: int = 4,
) -> BaselineModelBundle:
    if iterations <= 0 or threads <= 0:
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_TRAINING_CONFIG_INVALID",
        )
    weights = normalized_weights(training.sample_weight)
    common = {
        "iterations": iterations,
        "learning_rate": 0.05,
        "depth": 6,
        "l2_leaf_reg": 3.0,
        "random_seed": BASELINE_SEED,
        "random_strength": 0.0,
        "bootstrap_type": "No",
        "thread_count": threads,
        "allow_writing_files": False,
        "verbose": False,
    }
    classifier = CatBoostClassifier(
        loss_function="Logloss",
        eval_metric="Logloss",
        **common,
    ).fit(
        training.x,
        training.direction,
        sample_weight=weights,
    )
    alpha = ",".join(format(value, "g") for value in DEFAULT_QUANTILES)
    quantile_model = CatBoostRegressor(
        loss_function=f"MultiQuantile:alpha={alpha}",
        **common,
    ).fit(
        training.x,
        training.target_return,
        sample_weight=weights,
    )
    return BaselineModelBundle(
        family=CATBOOST_FAMILY,
        classifier=classifier,
        quantile_model=quantile_model,
    )


def fit_xgboost_baseline(
    training: BaselinePartition,
    *,
    iterations: int = DEFAULT_ITERATIONS,
    threads: int = 4,
) -> BaselineModelBundle:
    if iterations <= 0 or threads <= 0:
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_TRAINING_CONFIG_INVALID",
        )
    weights = normalized_weights(training.sample_weight)
    common = {
        "n_estimators": iterations,
        "learning_rate": 0.05,
        "max_depth": 6,
        "min_child_weight": 100.0,
        "reg_lambda": 3.0,
        "subsample": 1.0,
        "colsample_bytree": 1.0,
        "tree_method": "hist",
        "max_bin": 63,
        "random_state": BASELINE_SEED,
        "n_jobs": threads,
        "verbosity": 0,
    }
    classifier = XGBClassifier(
        objective="binary:logistic",
        eval_metric="logloss",
        **common,
    ).fit(
        training.x,
        training.direction,
        sample_weight=weights,
    )
    quantile_model = XGBRegressor(
        objective="reg:quantileerror",
        quantile_alpha=np.asarray(DEFAULT_QUANTILES),
        **common,
    ).fit(
        training.x,
        training.target_return,
        sample_weight=weights,
    )
    return BaselineModelBundle(
        family=XGBOOST_FAMILY,
        classifier=classifier,
        quantile_model=quantile_model,
    )


def fit_lightgbm_baseline(
    training: BaselinePartition,
    *,
    iterations: int = DEFAULT_ITERATIONS,
    threads: int = 4,
) -> BaselineModelBundle:
    if iterations <= 0 or threads <= 0:
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_TRAINING_CONFIG_INVALID",
        )
    weights = normalized_weights(training.sample_weight)
    common = {
        "n_estimators": iterations,
        "learning_rate": 0.05,
        "num_leaves": 31,
        "max_depth": 6,
        "min_child_samples": 100,
        "reg_lambda": 3.0,
        "random_state": BASELINE_SEED,
        "n_jobs": 1,
        "verbosity": -1,
        "deterministic": True,
        "force_col_wise": True,
    }
    with ThreadPoolExecutor(max_workers=min(threads, 8)) as executor:
        classifier_future = executor.submit(
            LGBMClassifier(objective="binary", **common).fit,
            training.x,
            training.direction,
            sample_weight=weights,
        )
        quantile_futures = [
            executor.submit(
                LGBMRegressor(
                    objective="quantile",
                    alpha=alpha,
                    **common,
                ).fit,
                training.x,
                training.target_return,
                sample_weight=weights,
            )
            for alpha in DEFAULT_QUANTILES
        ]
        classifier = classifier_future.result()
        quantile_models = tuple(
            future.result() for future in quantile_futures
        )
    return BaselineModelBundle(
        family=LIGHTGBM_FAMILY,
        classifier=classifier,
        quantile_model=quantile_models,
    )


def baseline_library_versions() -> dict[str, str]:
    return {
        "catboost": catboost.__version__,
        "lightgbm": lightgbm.__version__,
        "numpy": np.__version__,
        "scikitLearn": sklearn.__version__,
        "joblib": joblib.__version__,
        "xgboost": xgboost.__version__,
    }


def _readonly_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(
        f"{path.resolve().as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    return connection


def _fold_partition_range(
    fold_contract: dict,
    partition: str,
) -> tuple[str, str, int]:
    try:
        start_key, end_key, rows_key = PARTITION_RANGES[partition]
        return (
            fold_contract[start_key],
            fold_contract[end_key],
            int(fold_contract[rows_key]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_PARTITION_CONTRACT_INVALID",
        ) from exc


def _training_selection(
    sampling: sqlite3.Connection,
    fold: int,
    decision_date: str,
) -> dict[str, float]:
    rows = sampling.execute(
        "SELECT t.instrument_id, s.inverse_probability_weight "
        "FROM training_samples t JOIN sampling_strata s "
        "ON s.fold = t.fold AND s.decision_date = t.decision_date "
        "AND s.stratum_id = t.stratum_id "
        "WHERE t.fold = ? AND t.decision_date = ? "
        "ORDER BY t.instrument_id",
        (fold, decision_date),
    )
    return {row["instrument_id"]: float(row["inverse_probability_weight"]) for row in rows}


def _load_partition_from_connections(
    ranking: sqlite3.Connection,
    sampling: sqlite3.Connection,
    *,
    fold_contract: dict,
    partition: str,
    maximum_dates: int | None = None,
) -> BaselinePartition:
    if maximum_dates is not None and maximum_dates <= 0:
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_MAXIMUM_DATES_INVALID",
        )
    fold = int(fold_contract["fold"])
    start, end, expected_rows = _fold_partition_range(fold_contract, partition)
    decision_dates = [
        row[0]
        for row in ranking.execute(
            "SELECT DISTINCT decision_date FROM ranking_samples "
            "WHERE decision_date BETWEEN ? AND ? ORDER BY decision_date",
            (start, end),
        )
    ]
    if not decision_dates:
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_PARTITION_EMPTY",
        )
    if maximum_dates is not None:
        decision_dates = decision_dates[:maximum_dates]

    feature_blocks = []
    date_blocks = []
    board_blocks = []
    instrument_blocks = []
    target_blocks = []
    direction_blocks = []
    weight_blocks = []
    columns = ", ".join(RANKING_COLUMNS)
    for decision_date in decision_dates:
        rows = ranking.execute(
            f"SELECT {columns} FROM ranking_samples "
            "WHERE decision_date = ? ORDER BY board, instrument_id",
            (decision_date,),
        ).fetchall()
        if not rows:
            raise ProbabilisticBaselineError(
                "PROBABILISTIC_BASELINE_DATE_EMPTY",
            )
        date_features, _ = _date_features(
            rows,
            target_policy=GLOBAL_PERCENTILE_TARGET,
        )
        if partition == "train":
            selection = _training_selection(sampling, fold, decision_date)
            indices = np.asarray(
                [
                    index
                    for index, row in enumerate(rows)
                    if row["instrument_id"] in selection
                ],
                dtype=np.int64,
            )
            if len(indices) != len(selection):
                raise ProbabilisticBaselineError(
                    "PROBABILISTIC_BASELINE_TRAINING_ALIGNMENT_INVALID",
                )
            weights = np.asarray(
                [selection[rows[index]["instrument_id"]] for index in indices],
                dtype=np.float64,
            )
        else:
            indices = np.arange(len(rows), dtype=np.int64)
            weights = np.full(len(rows), 1.0 / len(rows), dtype=np.float64)
        selected = [rows[index] for index in indices]
        boards = np.asarray([row["board"] for row in selected])
        gross_returns = np.asarray(
            [float(row["forward_return_next_open_5"]) for row in selected],
            dtype=np.float64,
        )
        targets = fee_adjusted_returns(
            gross_returns,
            boards,
            np.asarray([row["execution_date"] for row in selected]),
            np.asarray([row["terminal_date"] for row in selected]),
        )
        feature_blocks.append(date_features[indices])
        date_blocks.append(
            np.full(len(selected), int(decision_date), dtype=np.int32),
        )
        board_blocks.append(
            np.asarray([BOARD_CODES[value] for value in boards], dtype=np.int8),
        )
        instrument_blocks.append(
            np.asarray(
                [row["instrument_id"].encode() for row in selected],
                dtype="S9",
            ),
        )
        target_blocks.append(targets.astype(np.float32))
        direction_blocks.append((targets > 0).astype(np.int8))
        weight_blocks.append(weights)

    result = BaselinePartition(
        x=np.concatenate(feature_blocks),
        dates=np.concatenate(date_blocks),
        boards=np.concatenate(board_blocks),
        instruments=np.concatenate(instrument_blocks),
        target_return=np.concatenate(target_blocks),
        direction=np.concatenate(direction_blocks),
        sample_weight=np.concatenate(weight_blocks),
    )
    if maximum_dates is None and len(result.x) != expected_rows:
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_PARTITION_COUNT_MISMATCH",
        )
    return result


class FoundationBaselineDataLoader:
    def __init__(
        self,
        foundation_dataset_root: Path,
        sampling_dataset_root: Path,
        ranking_dataset_root: Path,
    ):
        foundation, _ = verify_foundation_return_dataset(
            foundation_dataset_root,
        )
        sampling, sampling_database = verify_foundation_sampling_dataset(
            sampling_dataset_root,
        )
        ranking, ranking_database = _verified_ranking_database(
            ranking_dataset_root,
        )
        if (
            foundation["databaseSha256"]
            != sampling["foundationDatabaseSha256"]
            or foundation["rankingDataset"]["databaseSha256"]
            != ranking["databaseSha256"]
            or sampling["rankingDatabaseSha256"]
            != ranking["databaseSha256"]
        ):
            raise ProbabilisticBaselineError(
                "PROBABILISTIC_BASELINE_LINEAGE_MISMATCH",
            )
        self.foundation_manifest = foundation
        self.sampling_manifest = sampling
        self.ranking_manifest = ranking
        self.folds = {int(item["fold"]): item for item in sampling["folds"]}
        self.ranking = _readonly_database(ranking_database)
        self.sampling = _readonly_database(sampling_database)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()

    def close(self) -> None:
        self.sampling.close()
        self.ranking.close()

    def load_partition(
        self,
        fold: int,
        partition: str,
        *,
        maximum_dates: int | None = None,
    ) -> BaselinePartition:
        try:
            contract = self.folds[fold]
        except KeyError as exc:
            raise ProbabilisticBaselineError(
                "PROBABILISTIC_BASELINE_FOLD_INVALID",
            ) from exc
        return _load_partition_from_connections(
            self.ranking,
            self.sampling,
            fold_contract=contract,
            partition=partition,
            maximum_dates=maximum_dates,
        )


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _write_json(path: Path, payload: dict, *, immutable: bool = False) -> None:
    rendered = json.dumps(
        payload,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
        allow_nan=False,
    ) + "\n"
    if immutable and path.exists():
        if path.read_text() != rendered:
            raise ProbabilisticBaselineError(
                f"PROBABILISTIC_BASELINE_ARTIFACT_MISMATCH:{path.name}",
            )
        return
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(rendered)
    os.replace(temporary, path)


def _write_joblib(path: Path, payload: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    joblib.dump(payload, temporary, compress=3)
    os.replace(temporary, path)


def _write_predictions(
    path: Path,
    partition: BaselinePartition,
    predictions: dict[str, np.ndarray],
) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as stream:
        np.savez_compressed(
            stream,
            dates=partition.dates,
            boards=partition.boards,
            instruments=partition.instruments,
            actualReturn=partition.target_return,
            actualDirection=partition.direction,
            sampleWeight=partition.sample_weight,
            **predictions,
        )
    os.replace(temporary, path)


def build_baseline_protocol(
    experiment_root: Path,
    loader: FoundationBaselineDataLoader,
    *,
    iterations: int = DEFAULT_ITERATIONS,
    threads: int = 4,
    smoke_dates: int | None = None,
) -> dict:
    experiment = load_frozen_experiment(experiment_root)
    if (
        experiment.dataset.database_sha256
        != loader.foundation_manifest["databaseSha256"]
        or experiment.dataset.sampling_database_sha256
        != loader.sampling_manifest["databaseSha256"]
        or experiment.dataset.sampling_policy_sha256
        != loader.sampling_manifest["policySha256"]
        or experiment.dataset.feature_schema_sha256
        != loader.foundation_manifest["featureSchemaSha256"]
        or experiment.dataset.label_policy_sha256
        != loader.foundation_manifest["labelPolicySha256"]
    ):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_EXPERIMENT_LINEAGE_MISMATCH",
        )
    if (
        iterations <= 0
        or threads <= 0
        or (smoke_dates is not None and smoke_dates <= 0)
    ):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_TRAINING_CONFIG_INVALID",
        )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "experimentId": experiment_id(experiment),
        "experimentConfigSha256": experiment_config_sha256(experiment),
        "datasetId": loader.foundation_manifest["datasetId"],
        "foundationDatabaseSha256": loader.foundation_manifest["databaseSha256"],
        "rankingDatabaseSha256": loader.ranking_manifest["databaseSha256"],
        "samplingDatabaseSha256": loader.sampling_manifest["databaseSha256"],
        "samplingPolicySha256": loader.sampling_manifest["policySha256"],
        "featureSchemaSha256": loader.foundation_manifest["featureSchemaSha256"],
        "labelPolicySha256": loader.foundation_manifest["labelPolicySha256"],
        "featureNames": list(MODEL_FEATURE_NAMES),
        "quantiles": list(DEFAULT_QUANTILES),
        "families": list(MODEL_FAMILIES),
        "iterations": iterations,
        "seed": BASELINE_SEED,
        "hyperparameters": {
            "common": {
                "learningRate": 0.05,
                "maximumDepth": 6,
                "l2Regularization": 3.0,
                "randomSampling": False,
            },
            "catboost": {
                "quantileMode": "SINGLE_MULTIQUANTILE_MODEL",
                "bootstrapType": "No",
                "randomStrength": 0.0,
            },
            "xgboost": {
                "treeMethod": "hist",
                "maximumBins": 63,
                "minimumChildWeight": 100.0,
                "quantileMode": "SINGLE_MULTI_OUTPUT_MODEL",
            },
            "lightgbm": {
                "numberOfLeaves": 31,
                "minimumChildSamples": 100,
                "forceColumnWise": True,
                "quantileMode": "SEVEN_INDEPENDENT_MODELS",
                "parallelModelWorkers": min(threads, 8),
                "threadsPerModel": 1,
            },
        },
        "trainingSelection": "DETERMINISTIC_STRATIFIED_SAMPLE",
        "calibrationSelection": "FULL_UNIVERSE",
        "testSelection": "FULL_UNIVERSE",
        "feeTarget": "REFERENCE_FULL_FILL_FEE_ADJUSTED_5D",
        "fullUniverseEvaluation": smoke_dates is None,
        "smokeDatesPerPartition": smoke_dates,
        "confirmationFold": 5,
        "confirmationGate": "DEVELOPMENT_CONFIGURATION_FREEZE_REQUIRED",
        "libraryVersions": baseline_library_versions(),
        "sourceSha256": _file_sha256(Path(__file__)),
        "releaseStatus": "UNAVAILABLE",
    }


def fit_baseline_model(
    family: str,
    training: BaselinePartition,
    *,
    iterations: int,
    threads: int,
) -> HistoricalBaselineModel | BaselineModelBundle:
    if family == HISTORICAL_FAMILY:
        return fit_historical_baseline(training)
    fitters = {
        CATBOOST_FAMILY: fit_catboost_baseline,
        XGBOOST_FAMILY: fit_xgboost_baseline,
        LIGHTGBM_FAMILY: fit_lightgbm_baseline,
    }
    try:
        fitter = fitters[family]
    except KeyError as exc:
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_FAMILY_INVALID",
        ) from exc
    return fitter(training, iterations=iterations, threads=threads)


def _receipt_is_valid(root: Path) -> dict | None:
    receipt_path = root / "receipt.json"
    try:
        receipt = json.loads(receipt_path.read_text())
        files = receipt["files"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        return None
    if not files or any(
        not (root / name).is_file()
        or _file_sha256(root / name) != expected_hash
        for name, expected_hash in files.items()
    ):
        return None
    return receipt


def _require_development_freeze(output_root: Path, protocol_path: Path) -> None:
    freeze_path = output_root / "development-freeze.json"
    try:
        frozen = json.loads(freeze_path.read_text())
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_CONFIRMATION_LOCKED",
        ) from exc
    if (
        frozen.get("schemaVersion")
        != "foundation-probabilistic-baseline-development-freeze.v1"
        or frozen.get("protocolSha256") != _file_sha256(protocol_path)
        or frozen.get("completedDevelopmentFolds") != [1, 2, 3, 4]
        or frozen.get("families") != list(MODEL_FAMILIES)
    ):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_CONFIRMATION_LOCKED",
        )
    for key, expected_hash in frozen.get("receiptSha256", {}).items():
        fold, family = key.split(":", 1)
        receipt_path = output_root / f"fold-{fold}" / family / "receipt.json"
        if (
            not receipt_path.is_file()
            or _file_sha256(receipt_path) != expected_hash
            or _receipt_is_valid(receipt_path.parent) is None
        ):
            raise ProbabilisticBaselineError(
                "PROBABILISTIC_BASELINE_CONFIRMATION_LOCKED",
            )


def run_baseline_families_fold(
    loader: FoundationBaselineDataLoader,
    *,
    experiment_root: Path,
    output_root: Path,
    fold: int,
    families: tuple[str, ...] = MODEL_FAMILIES,
    iterations: int = DEFAULT_ITERATIONS,
    threads: int = 4,
    smoke_dates: int | None = None,
) -> dict[str, dict]:
    if (
        fold not in loader.folds
        or not families
        or len(set(families)) != len(families)
        or any(family not in MODEL_FAMILIES for family in families)
    ):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_RUN_CONFIG_INVALID",
        )
    output_root.mkdir(parents=True, exist_ok=True)
    protocol_path = output_root / "protocol.json"
    protocol = build_baseline_protocol(
        experiment_root,
        loader,
        iterations=iterations,
        threads=threads,
        smoke_dates=smoke_dates,
    )
    _write_json(protocol_path, protocol, immutable=True)
    if fold == 5 and smoke_dates is None:
        _require_development_freeze(output_root, protocol_path)

    roots = {
        family: output_root / f"fold-{fold}" / family
        for family in families
    }
    completed = {}
    pending = []
    for family, root in roots.items():
        root.mkdir(parents=True, exist_ok=True)
        receipt = _receipt_is_valid(root)
        if (
            receipt is not None
            and receipt.get("protocolSha256") == _file_sha256(protocol_path)
        ):
            completed[family] = receipt
        else:
            pending.append(family)
    if not pending:
        return completed

    print(
        json.dumps(
            {"state": "LOADING_TRAIN", "fold": fold, "families": pending},
        ),
        flush=True,
    )
    training = loader.load_partition(
        fold,
        "train",
        maximum_dates=smoke_dates,
    )
    training_summary = {
        "rows": len(training.x),
        "dates": int(len(np.unique(training.dates))),
        "startDate": str(training.dates.min()),
        "endDate": str(training.dates.max()),
    }
    models = {}
    model_paths = {}
    for family in pending:
        print(
            json.dumps(
                {"state": "FITTING", "fold": fold, "family": family},
            ),
            flush=True,
        )
        model = fit_baseline_model(
            family,
            training,
            iterations=iterations,
            threads=threads,
        )
        model_path = roots[family] / "model.joblib"
        _write_joblib(model_path, model)
        models[family] = model
        model_paths[family] = model_path
    del training
    gc.collect()

    metrics = {family: {} for family in pending}
    prediction_paths = {family: {} for family in pending}
    for partition_name in (
        "probabilityCalibration",
        "conformalCalibration",
        "test",
    ):
        print(
            json.dumps(
                {
                    "state": "LOADING_EVALUATION",
                    "fold": fold,
                    "partition": partition_name,
                },
            ),
            flush=True,
        )
        partition = loader.load_partition(
            fold,
            partition_name,
            maximum_dates=smoke_dates,
        )
        if int(training_summary["endDate"]) >= int(partition.dates.min()):
            raise ProbabilisticBaselineError(
                "PROBABILISTIC_BASELINE_TRAIN_TEST_OVERLAP",
            )
        for family, model in models.items():
            print(
                json.dumps(
                    {
                        "state": "PREDICTING",
                        "fold": fold,
                        "family": family,
                        "partition": partition_name,
                    },
                ),
                flush=True,
            )
            predictions = model.predict(partition.x)
            metrics[family][partition_name] = evaluate_predictions(
                partition,
                predictions,
            )
            prediction_path = roots[family] / f"{partition_name}.npz"
            _write_predictions(prediction_path, partition, predictions)
            prediction_paths[family][prediction_path.name] = _file_sha256(
                prediction_path,
            )
            del predictions
        del partition
        gc.collect()

    for family in pending:
        root = roots[family]
        evaluation_path = root / "evaluation.json"
        _write_json(
            evaluation_path,
            {
                "schemaVersion": "foundation-probabilistic-baseline-evaluation.v1",
                "fold": fold,
                "family": family,
                "usage": "SMOKE_ONLY" if smoke_dates is not None else "FULL_OOF",
                "training": training_summary,
                "partitions": metrics[family],
                "releaseStatus": "UNAVAILABLE",
            },
            immutable=True,
        )
        receipt = {
            "schemaVersion": "foundation-probabilistic-baseline-receipt.v1",
            "fold": fold,
            "family": family,
            "usage": "SMOKE_ONLY" if smoke_dates is not None else "FULL_OOF",
            "protocolSha256": _file_sha256(protocol_path),
            "files": {
                "model.joblib": _file_sha256(model_paths[family]),
                "evaluation.json": _file_sha256(evaluation_path),
                **prediction_paths[family],
            },
            "releaseStatus": "UNAVAILABLE",
        }
        _write_json(root / "receipt.json", receipt, immutable=True)
        completed[family] = receipt
    return completed


def run_baseline_fold(
    loader: FoundationBaselineDataLoader,
    *,
    experiment_root: Path,
    output_root: Path,
    fold: int,
    family: str,
    iterations: int = DEFAULT_ITERATIONS,
    threads: int = 4,
    smoke_dates: int | None = None,
) -> dict:
    return run_baseline_families_fold(
        loader,
        experiment_root=experiment_root,
        output_root=output_root,
        fold=fold,
        families=(family,),
        iterations=iterations,
        threads=threads,
        smoke_dates=smoke_dates,
    )[family]


def freeze_development_configuration(output_root: Path) -> dict:
    protocol_path = output_root / "protocol.json"
    try:
        protocol = json.loads(protocol_path.read_text())
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_PROTOCOL_INVALID",
        ) from exc
    if (
        protocol.get("schemaVersion") != SCHEMA_VERSION
        or not protocol.get("fullUniverseEvaluation")
    ):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_DEVELOPMENT_INCOMPLETE",
        )
    receipts = {}
    for fold in range(1, 5):
        for family in MODEL_FAMILIES:
            root = output_root / f"fold-{fold}" / family
            receipt = _receipt_is_valid(root)
            if (
                receipt is None
                or receipt.get("fold") != fold
                or receipt.get("family") != family
                or receipt.get("usage") != "FULL_OOF"
            ):
                raise ProbabilisticBaselineError(
                    "PROBABILISTIC_BASELINE_DEVELOPMENT_INCOMPLETE",
                )
            receipts[f"{fold}:{family}"] = _file_sha256(
                root / "receipt.json",
            )
    payload = {
        "schemaVersion": "foundation-probabilistic-baseline-development-freeze.v1",
        "protocolSha256": _file_sha256(protocol_path),
        "completedDevelopmentFolds": [1, 2, 3, 4],
        "families": list(MODEL_FAMILIES),
        "receiptSha256": receipts,
        "hyperparametersFrozen": True,
        "calibrationMethodFrozen": True,
        "confirmationFold": 5,
        "releaseStatus": "UNAVAILABLE",
    }
    _write_json(
        output_root / "development-freeze.json",
        payload,
        immutable=True,
    )
    return payload


def _round_cny(values: np.ndarray) -> np.ndarray:
    cents = np.nextafter(values * 100.0 + 0.5, np.inf)
    return np.floor(cents) / 100.0


def fee_adjusted_returns(
    gross_returns: np.ndarray,
    boards: np.ndarray,
    execution_dates: np.ndarray,
    terminal_dates: np.ndarray,
) -> np.ndarray:
    """Vectorized equivalent of the frozen Decimal 100k fee policy."""
    gross = np.asarray(gross_returns, dtype=np.float64)
    board = np.asarray(boards)
    execution = np.asarray(execution_dates)
    terminal = np.asarray(terminal_dates)
    if (
        gross.ndim != 1
        or any(values.ndim != 1 for values in (board, execution, terminal))
        or len({len(gross), len(board), len(execution), len(terminal)}) != 1
        or not np.all(np.isfinite(gross))
        or np.any(gross <= -1.0)
        or not np.all(np.isin(board, VALID_BOARDS))
    ):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_LABEL_INPUT_INVALID",
        )

    pre_cutoff_transfer = np.where(board == "BEIJING", 0.000025, 0.00002)
    buy_transfer_rate = np.where(
        execution >= "20220429",
        0.00001,
        pre_cutoff_transfer,
    )
    sell_transfer_rate = np.where(
        terminal >= "20220429",
        0.00001,
        pre_cutoff_transfer,
    )
    stamp_rate = np.where(terminal >= "20230828", 0.0005, 0.001)

    buy_commission = 30.0
    buy_transfer = _round_cny(REFERENCE_NOTIONAL_CNY * buy_transfer_rate)
    buy_fees = buy_commission + buy_transfer

    sell_gross = (
        REFERENCE_NOTIONAL_CNY
        * (1.0 + gross)
        * (1.0 - MARKET_EXIT_SLIPPAGE_RATE)
    )
    sell_commission = _round_cny(np.maximum(5.0, sell_gross * 0.0003))
    sell_transfer = _round_cny(sell_gross * sell_transfer_rate)
    stamp_duty = _round_cny(sell_gross * stamp_rate)
    return (
        sell_gross
        - sell_commission
        - sell_transfer
        - stamp_duty
        - REFERENCE_NOTIONAL_CNY
        - buy_fees
    ) / (REFERENCE_NOTIONAL_CNY + buy_fees)


def normalized_weights(sample_weight: np.ndarray) -> np.ndarray:
    weights = np.asarray(sample_weight, dtype=np.float64)
    if (
        weights.ndim != 1
        or len(weights) == 0
        or not np.all(np.isfinite(weights))
        or np.any(weights <= 0)
    ):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_WEIGHT_INVALID",
        )
    return weights / np.mean(weights)


def weighted_quantiles(
    values: np.ndarray,
    quantiles: tuple[float, ...] = DEFAULT_QUANTILES,
    *,
    sample_weight: np.ndarray,
) -> np.ndarray:
    samples = np.asarray(values, dtype=np.float64)
    weights = np.asarray(sample_weight, dtype=np.float64)
    requested = np.asarray(quantiles, dtype=np.float64)
    if (
        samples.ndim != 1
        or weights.ndim != 1
        or len(samples) != len(weights)
        or len(samples) == 0
        or not np.all(np.isfinite(samples))
        or np.any(weights <= 0)
        or not np.all(np.isfinite(weights))
        or requested.ndim != 1
        or len(requested) == 0
        or np.any(requested <= 0)
        or np.any(requested >= 1)
        or np.any(np.diff(requested) <= 0)
    ):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_QUANTILE_INPUT_INVALID",
        )
    order = np.argsort(samples, kind="stable")
    ordered = samples[order]
    cumulative = np.cumsum(weights[order])
    indices = np.searchsorted(
        cumulative,
        requested * cumulative[-1],
        side="left",
    )
    return ordered[np.minimum(indices, len(ordered) - 1)]


def historical_baseline_predictions(
    training: BaselinePartition,
    rows: int,
    *,
    quantiles: tuple[float, ...] = DEFAULT_QUANTILES,
) -> dict[str, np.ndarray]:
    if rows <= 0:
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_PREDICTION_ROWS_INVALID",
        )
    probability = float(
        np.average(training.direction, weights=training.sample_weight),
    )
    values = weighted_quantiles(
        training.target_return,
        quantiles,
        sample_weight=training.sample_weight,
    )
    predictions = {
        "pWin": np.full(rows, probability, dtype=np.float32),
    }
    predictions.update(
        {
            f"q{round(alpha * 100):02d}": np.full(
                rows,
                value,
                dtype=np.float32,
            )
            for alpha, value in zip(quantiles, values, strict=True)
        }
    )
    return predictions


def _weighted_interval_score(
    actual: np.ndarray,
    predicted: dict[str, np.ndarray],
    weights: np.ndarray,
) -> float:
    median_error = np.abs(actual - predicted["q50"])
    total = 0.5 * median_error
    for lower_name, upper_name, alpha in (
        ("q05", "q95", 0.10),
        ("q10", "q90", 0.20),
        ("q25", "q75", 0.50),
    ):
        lower = predicted[lower_name]
        upper = predicted[upper_name]
        interval_score = (
            upper
            - lower
            + (2.0 / alpha) * np.maximum(lower - actual, 0.0)
            + (2.0 / alpha) * np.maximum(actual - upper, 0.0)
        )
        total += (alpha / 2.0) * interval_score
    return float(np.average(total / 3.5, weights=weights))


def _ranking_metrics(
    partition: BaselinePartition,
    scores: np.ndarray,
) -> dict:
    daily_rank_ic = []
    daily_top10 = []
    daily_market = []
    for decision_date in np.unique(partition.dates):
        mask = partition.dates == decision_date
        actual = partition.target_return[mask]
        predicted = scores[mask]
        if len(actual) < 2 or np.ptp(predicted) == 0:
            rank_ic = 0.0
        else:
            rank_ic = float(
                np.corrcoef(
                    rankdata(predicted, method="average"),
                    rankdata(actual, method="average"),
                )[0, 1]
            )
        daily_rank_ic.append(rank_ic)
        selected = np.argsort(predicted)[-min(10, len(predicted)) :]
        daily_top10.append(float(np.mean(actual[selected])))
        daily_market.append(float(np.mean(actual)))
    return {
        "meanDailyRankIc": float(np.mean(daily_rank_ic)),
        "medianDailyRankIc": float(np.median(daily_rank_ic)),
        "top10MeanNetReturn": float(np.mean(daily_top10)),
        "marketMeanNetReturn": float(np.mean(daily_market)),
        "top10NetReturnIncrement": float(
            np.mean(daily_top10) - np.mean(daily_market)
        ),
    }


def evaluate_predictions(
    partition: BaselinePartition,
    predictions: dict[str, np.ndarray],
    *,
    quantiles: tuple[float, ...] = DEFAULT_QUANTILES,
) -> dict:
    required = {
        "pWin",
        *(f"q{round(alpha * 100):02d}" for alpha in quantiles),
    }
    if set(predictions) != required or any(
        np.asarray(values).shape != (len(partition.x),)
        or not np.all(np.isfinite(values))
        for values in predictions.values()
    ):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_PREDICTIONS_INVALID",
        )
    probability = np.clip(
        np.asarray(predictions["pWin"], dtype=np.float64),
        1e-7,
        1.0 - 1e-7,
    )
    if np.any((predictions["pWin"] < 0) | (predictions["pWin"] > 1)):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_PROBABILITY_INVALID",
        )
    quantile_matrix = np.column_stack(
        [
            np.asarray(
                predictions[f"q{round(alpha * 100):02d}"],
                dtype=np.float64,
            )
            for alpha in quantiles
        ]
    )
    if np.any(np.diff(quantile_matrix, axis=1) < 0):
        raise ProbabilisticBaselineError(
            "PROBABILISTIC_BASELINE_QUANTILE_CROSSING",
        )
    weights = normalized_weights(partition.sample_weight)
    actual = partition.target_return.astype(np.float64)
    direction = partition.direction.astype(np.int8)
    pinball = {
        f"q{round(alpha * 100):02d}": float(
            mean_pinball_loss(
                actual,
                quantile_matrix[:, index],
                alpha=alpha,
                sample_weight=weights,
            )
        )
        for index, alpha in enumerate(quantiles)
    }
    covered80 = (actual >= predictions["q10"]) & (
        actual <= predictions["q90"]
    )
    return {
        "samples": len(actual),
        "dates": int(len(np.unique(partition.dates))),
        "startDate": str(partition.dates.min()),
        "endDate": str(partition.dates.max()),
        "brier": float(
            np.average((probability - direction) ** 2, weights=weights)
        ),
        "logLoss": float(
            log_loss(
                direction,
                probability,
                labels=[0, 1],
                sample_weight=weights,
            )
        ),
        "pinball": pinball,
        "meanPinball": float(np.mean(tuple(pinball.values()))),
        "weightedIntervalScore": _weighted_interval_score(
            actual,
            predictions,
            weights,
        ),
        "interval80Coverage": float(np.average(covered80, weights=weights)),
        "interval80MeanWidth": float(
            np.average(
                predictions["q90"] - predictions["q10"],
                weights=weights,
            )
        ),
        "ranking": _ranking_metrics(partition, predictions["q50"]),
    }


def _run_command(args: argparse.Namespace) -> dict:
    output_root = args.output.expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    lock_path = output_root / "run.lock"
    with lock_path.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ProbabilisticBaselineError(
                "PROBABILISTIC_BASELINE_ALREADY_RUNNING",
            ) from exc
        with FoundationBaselineDataLoader(
            args.foundation_root,
            args.sampling_root,
            args.ranking_root,
        ) as loader:
            if args.family == "all":
                return run_baseline_families_fold(
                    loader,
                    experiment_root=args.experiment_root,
                    output_root=output_root,
                    fold=args.fold,
                    iterations=args.iterations,
                    threads=args.threads,
                    smoke_dates=args.smoke_dates,
                )
            return run_baseline_fold(
                loader,
                experiment_root=args.experiment_root,
                output_root=output_root,
                fold=args.fold,
                family=args.family,
                iterations=args.iterations,
                threads=args.threads,
                smoke_dates=args.smoke_dates,
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--experiment-root", type=Path, required=True)
    run_parser.add_argument("--foundation-root", type=Path, required=True)
    run_parser.add_argument("--sampling-root", type=Path, required=True)
    run_parser.add_argument("--ranking-root", type=Path, required=True)
    run_parser.add_argument("--output", type=Path, required=True)
    run_parser.add_argument("--fold", type=int, required=True)
    run_parser.add_argument(
        "--family",
        choices=(*MODEL_FAMILIES, "all"),
        required=True,
    )
    run_parser.add_argument(
        "--iterations",
        type=int,
        default=DEFAULT_ITERATIONS,
    )
    run_parser.add_argument("--threads", type=int, default=4)
    run_parser.add_argument("--smoke-dates", type=int)
    freeze_parser = subparsers.add_parser("freeze-development")
    freeze_parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "freeze-development":
        result = freeze_development_configuration(
            args.output.expanduser().resolve(),
        )
    else:
        result = _run_command(args)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
