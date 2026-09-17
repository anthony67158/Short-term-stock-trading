"""Reproducible probabilistic tree baselines on frozen foundation folds."""

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import catboost
import numpy as np
import xgboost
from catboost import CatBoostClassifier, CatBoostRegressor
from xgboost import XGBClassifier, XGBRegressor

from platform_app.modules.experiments.foundation_return_contract import (
    DEFAULT_QUANTILES,
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


def baseline_library_versions() -> dict[str, str]:
    return {
        "catboost": catboost.__version__,
        "numpy": np.__version__,
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
) -> BaselinePartition:
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
    if len(result.x) != expected_rows:
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

    def load_partition(self, fold: int, partition: str) -> BaselinePartition:
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
        )


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
