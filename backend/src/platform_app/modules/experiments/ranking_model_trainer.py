"""Train and evaluate the full-universe cross-sectional ranking model."""

import hashlib
import json
import os
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import groupby
from pathlib import Path

import joblib
import lightgbm
import numpy as np
import sklearn
from lightgbm import LGBMRanker, early_stopping, log_evaluation
from scipy.stats import rankdata
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error

from platform_app.modules.experiments.quant_model_trainer import (
    RANDOM_STATE,
    QuantModelError,
    temporal_split,
)

MODEL_SCHEMA_VERSION = "ranking-model-bundle.v1"
BOARD_PERCENTILE_TARGET = "board-percentile-v1"
GLOBAL_PERCENTILE_TARGET = "global-percentile-v2"
RANKING_TARGET_POLICIES = (
    BOARD_PERCENTILE_TARGET,
    GLOBAL_PERCENTILE_TARGET,
)
HGB_MODEL_FAMILY = "hgb-mse-v1"
LAMBDARANK_MODEL_FAMILY = "lightgbm-lambdarank-v1"
MODEL_FAMILIES = (HGB_MODEL_FAMILY, LAMBDARANK_MODEL_FAMILY)
DEFAULT_RELEVANCE_LEVELS = 5
LINEAR_LABEL_GAIN_POLICY = "linear-v1"
RAW_COLUMNS = (
    "adjusted_return_1",
    "adjusted_return_5",
    "adjusted_return_10",
    "adjusted_return_20",
    "adjusted_return_60",
    "realized_volatility_5",
    "realized_volatility_20",
    "realized_volatility_60",
    "drawdown_from_high_20",
    "distance_from_low_20",
    "median_amount_5_cny",
    "median_amount_20_cny",
    "median_amount_60_cny",
    "amount_to_median_20",
    "mean_range_20",
    "gap_1",
    "close_location_1",
    "listing_age_days",
)
MODEL_FEATURE_NAMES = (
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
BOARD_CODES = {"MAIN": 0, "CHINEXT": 1, "STAR": 2, "BEIJING": 3}


@dataclass
class RankingTrainingData:
    x: np.ndarray
    dates: np.ndarray
    boards: np.ndarray
    instruments: np.ndarray
    target_return: np.ndarray
    target_rank: np.ndarray
    sample_weight: np.ndarray
    target_policy: str = BOARD_PERCENTILE_TARGET


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _verified_ranking_database(root: Path) -> tuple[dict, Path]:
    manifest_path = root.resolve() / "manifest.json"
    if not manifest_path.is_file():
        raise QuantModelError("RANKING_DATASET_NOT_SEALED")
    manifest = json.loads(manifest_path.read_text())
    database = root.resolve() / manifest["database"]
    if (
        manifest.get("schemaVersion") != "ranking-dataset.v1"
        or not database.is_file()
        or _file_sha256(database) != manifest.get("databaseSha256")
    ):
        raise QuantModelError("RANKING_DATASET_HASH_MISMATCH")
    return manifest, database


def _percentile_ranks(values: np.ndarray) -> np.ndarray:
    if len(values) == 1:
        return np.array([0.5], dtype=np.float32)
    return ((rankdata(values, method="average") - 1) / (len(values) - 1)).astype(
        np.float32
    )


def _date_features(
    rows: list[sqlite3.Row],
    *,
    target_policy: str = BOARD_PERCENTILE_TARGET,
) -> tuple[np.ndarray, np.ndarray]:
    if target_policy not in RANKING_TARGET_POLICIES:
        raise QuantModelError("RANKING_TARGET_POLICY_UNSUPPORTED")
    raw = np.asarray(
        [[float(row[column]) for column in RAW_COLUMNS] for row in rows],
        dtype=np.float32,
    )
    boards = np.asarray([BOARD_CODES[row["board"]] for row in rows], dtype=np.int8)
    transformed = raw.copy()
    transformed[:, 10:13] = np.log1p(transformed[:, 10:13])
    transformed[:, 17] = np.log1p(transformed[:, 17])
    board_one_hot = np.eye(4, dtype=np.float32)[boards]
    market = np.asarray(
        [
            np.mean(raw[:, 0]),
            np.mean(raw[:, 3]),
            np.mean(raw[:, 3] > 0),
            np.median(raw[:, 6]),
        ],
        dtype=np.float32,
    )
    market_features = np.repeat(market.reshape(1, -1), len(rows), axis=0)
    relative = np.empty((len(rows), 5), dtype=np.float32)
    relative_columns = (1, 3, 4, 6, 11)
    target_return = np.asarray(
        [float(row["forward_return_next_open_5"]) for row in rows],
        dtype=np.float32,
    )
    target_rank = np.empty(len(rows), dtype=np.float32)
    for board_code in range(4):
        mask = boards == board_code
        for output_index, raw_index in enumerate(relative_columns):
            relative[mask, output_index] = _percentile_ranks(raw[mask, raw_index])
        if target_policy == BOARD_PERCENTILE_TARGET:
            target_rank[mask] = _percentile_ranks(target_return[mask])
    if target_policy == GLOBAL_PERCENTILE_TARGET:
        target_rank = _percentile_ranks(target_return)
    return (
        np.concatenate(
            [transformed, board_one_hot, market_features, relative],
            axis=1,
        ),
        target_rank,
    )


def load_ranking_training_data(
    ranking_dataset_root: Path,
    *,
    target_policy: str = BOARD_PERCENTILE_TARGET,
) -> tuple[RankingTrainingData, dict]:
    if target_policy not in RANKING_TARGET_POLICIES:
        raise QuantModelError("RANKING_TARGET_POLICY_UNSUPPORTED")
    manifest, database_path = _verified_ranking_database(ranking_dataset_root)
    count = int(manifest["samples"])
    x = np.empty((count, len(MODEL_FEATURE_NAMES)), dtype=np.float32)
    dates = np.empty(count, dtype=np.int32)
    boards = np.empty(count, dtype=np.int8)
    instruments = np.empty(count, dtype="S9")
    target_return = np.empty(count, dtype=np.float32)
    target_rank = np.empty(count, dtype=np.float32)
    sample_weight = np.empty(count, dtype=np.float32)
    uri = f"{database_path.resolve().as_uri()}?mode=ro&immutable=1"
    database = sqlite3.connect(uri, uri=True)
    database.row_factory = sqlite3.Row
    columns = ", ".join((*RAW_COLUMNS, "forward_return_next_open_5"))
    rows = database.execute(
        f"SELECT instrument_id, decision_date, board, {columns} "
        "FROM ranking_samples ORDER BY decision_date, board, instrument_id"
    )
    offset = 0
    for decision_date, group in groupby(rows, key=lambda row: row["decision_date"]):
        group_rows = list(group)
        group_x, group_target_rank = _date_features(
            group_rows,
            target_policy=target_policy,
        )
        end = offset + len(group_rows)
        x[offset:end] = group_x
        dates[offset:end] = int(decision_date)
        boards[offset:end] = [BOARD_CODES[row["board"]] for row in group_rows]
        instruments[offset:end] = [
            row["instrument_id"].encode() for row in group_rows
        ]
        target_return[offset:end] = [
            float(row["forward_return_next_open_5"]) for row in group_rows
        ]
        target_rank[offset:end] = group_target_rank
        sample_weight[offset:end] = 1 / len(group_rows)
        offset = end
    database.close()
    if offset != count:
        raise QuantModelError("RANKING_SAMPLE_COUNT_MISMATCH")
    return (
        RankingTrainingData(
            x=x,
            dates=dates,
            boards=boards,
            instruments=instruments,
            target_return=target_return,
            target_rank=target_rank,
            sample_weight=sample_weight,
            target_policy=target_policy,
        ),
        manifest,
    )


def _daily_backtest_metrics(
    dates: np.ndarray,
    boards: np.ndarray,
    actual_returns: np.ndarray,
    scores: np.ndarray,
) -> dict:
    daily_ic = []
    selected_returns = []
    market_returns = []
    selections_by_board = {name: 0 for name in BOARD_CODES}
    unique_dates = np.unique(dates)
    for decision_date in unique_dates:
        date_mask = dates == decision_date
        date_scores = scores[date_mask]
        date_returns = actual_returns[date_mask]
        if len(date_returns) < 10:
            continue
        predicted_rank = _percentile_ranks(date_scores)
        actual_rank = _percentile_ranks(date_returns)
        daily_ic.append(float(np.corrcoef(predicted_rank, actual_rank)[0, 1]))
        selected_local = np.argsort(date_scores)[-min(10, len(date_scores)) :]
        selected_returns.extend(date_returns[selected_local])
        market_returns.append(float(np.mean(date_returns)))
        date_boards = boards[date_mask]
        for code in date_boards[selected_local]:
            board = next(name for name, value in BOARD_CODES.items() if value == code)
            selections_by_board[board] += 1
    selected = np.asarray(selected_returns, dtype=np.float32)
    market = np.asarray(market_returns, dtype=np.float32)
    return {
        "dates": int(len(daily_ic)),
        "meanDailyRankIc": float(np.nanmean(daily_ic)),
        "medianDailyRankIc": float(np.nanmedian(daily_ic)),
        "top10MeanGrossReturn": float(np.mean(selected)),
        "top10MeanReturnAt10BpsStress": float(np.mean(selected) - 0.001),
        "marketMeanGrossReturn": float(np.mean(market)),
        "top10PositiveRate": float(np.mean(selected > 0)),
        "selectedTrades": int(len(selected)),
        "selectionsByBoard": selections_by_board,
    }


def _group_sizes(dates: np.ndarray) -> np.ndarray:
    _, counts = np.unique(dates, return_counts=True)
    return counts.astype(np.int32)


def _relevance_labels(
    target_rank: np.ndarray,
    *,
    levels: int = DEFAULT_RELEVANCE_LEVELS,
) -> np.ndarray:
    if levels < 2:
        raise QuantModelError("RANKING_RELEVANCE_LEVELS_INVALID")
    return np.minimum(
        (target_rank * levels).astype(np.int32),
        levels - 1,
    )


def _linear_label_gain(levels: int) -> list[int]:
    if levels < 2:
        raise QuantModelError("RANKING_RELEVANCE_LEVELS_INVALID")
    return list(range(levels))


def train_ranking_models(
    data: RankingTrainingData,
    *,
    max_iter: int = 120,
    min_samples_leaf: int = 200,
    model_family: str = HGB_MODEL_FAMILY,
    relevance_levels: int = DEFAULT_RELEVANCE_LEVELS,
) -> tuple[dict, dict]:
    if model_family not in MODEL_FAMILIES:
        raise QuantModelError("RANKING_MODEL_FAMILY_UNSUPPORTED")
    if (
        model_family != LAMBDARANK_MODEL_FAMILY
        and relevance_levels != DEFAULT_RELEVANCE_LEVELS
    ):
        raise QuantModelError("RANKING_RELEVANCE_LEVELS_REQUIRE_LAMBDARANK")
    split = temporal_split(data.dates)
    train, calibration, confirmation = split.masks(data.dates)
    common = {
        "learning_rate": 0.05,
        "max_iter": max_iter,
        "max_leaf_nodes": 31,
        "min_samples_leaf": min_samples_leaf,
        "l2_regularization": 1.0,
        "early_stopping": False,
        "random_state": RANDOM_STATE,
    }
    if model_family == HGB_MODEL_FAMILY:
        rank_model = HistGradientBoostingRegressor(
            loss="squared_error",
            **common,
        ).fit(
            data.x[train],
            data.target_rank[train],
            sample_weight=data.sample_weight[train],
        )
    else:
        rank_model = LGBMRanker(
            objective="lambdarank",
            learning_rate=0.05,
            n_estimators=max_iter,
            num_leaves=31,
            max_depth=6,
            min_child_samples=min_samples_leaf,
            reg_lambda=1.0,
            max_bin=63,
            deterministic=True,
            force_col_wise=True,
            label_gain=_linear_label_gain(relevance_levels),
            random_state=RANDOM_STATE,
            n_jobs=8,
            verbosity=-1,
        )
        mean_group_size = float(np.mean(_group_sizes(data.dates[train])))
        rank_model.fit(
            data.x[train],
            _relevance_labels(
                data.target_rank[train],
                levels=relevance_levels,
            ),
            sample_weight=data.sample_weight[train] * mean_group_size,
            group=_group_sizes(data.dates[train]),
            eval_X=data.x[calibration],
            eval_y=_relevance_labels(
                data.target_rank[calibration],
                levels=relevance_levels,
            ),
            eval_group=[_group_sizes(data.dates[calibration])],
            eval_at=(10, 50),
            callbacks=[early_stopping(20, verbose=False), log_evaluation(0)],
        )
    lower, upper = np.quantile(data.target_return[train], [0.005, 0.995])
    clipped_return = np.clip(data.target_return, lower, upper)
    return_model = HistGradientBoostingRegressor(
        loss="squared_error",
        **common,
    ).fit(
        data.x[train],
        clipped_return[train],
        sample_weight=data.sample_weight[train],
    )
    rank_scores = rank_model.predict(data.x[confirmation])
    return_predictions = return_model.predict(data.x[confirmation])
    metrics = {
        "modelFamily": model_family,
        "rankingTargetPolicy": data.target_policy,
        "relevanceLevels": (
            relevance_levels if model_family == LAMBDARANK_MODEL_FAMILY else None
        ),
        "labelGainPolicy": (
            LINEAR_LABEL_GAIN_POLICY
            if model_family == LAMBDARANK_MODEL_FAMILY
            else None
        ),
        "split": split.as_dict(),
        "confirmationSamples": int(np.sum(confirmation)),
        "expectedReturnMae": float(
            mean_absolute_error(
                data.target_return[confirmation],
                return_predictions,
            )
        ),
        "backtest": _daily_backtest_metrics(
            data.dates[confirmation],
            data.boards[confirmation],
            data.target_return[confirmation],
            rank_scores,
        ),
        "trainingTargetClip": {
            "lower": float(lower),
            "upper": float(upper),
        },
    }
    return {"rank": rank_model, "expectedGrossReturn": return_model}, metrics


def write_ranking_bundle(
    *,
    output_root: Path,
    bundle_id: str,
    data: RankingTrainingData,
    ranking_manifest: dict,
    max_iter: int = 120,
    model_family: str = HGB_MODEL_FAMILY,
    relevance_levels: int = DEFAULT_RELEVANCE_LEVELS,
) -> dict:
    root = output_root.resolve()
    manifest_path = root / "manifest.json"
    if manifest_path.exists():
        raise QuantModelError("RANKING_MODEL_BUNDLE_ALREADY_EXISTS")
    root.mkdir(parents=True, exist_ok=True)
    models, metrics = train_ranking_models(
        data,
        max_iter=max_iter,
        model_family=model_family,
        relevance_levels=relevance_levels,
    )
    artifact_path = root / "models.joblib"
    joblib.dump(
        {
            "schemaVersion": MODEL_SCHEMA_VERSION,
            "featureNames": MODEL_FEATURE_NAMES,
            "models": models,
        },
        artifact_path,
        compress=3,
    )
    manifest = {
        "bundleId": bundle_id,
        "schemaVersion": MODEL_SCHEMA_VERSION,
        "createdAt": datetime.now(UTC).isoformat(),
        "artifact": artifact_path.name,
        "artifactSha256": _file_sha256(artifact_path),
        "rankingDatasetId": ranking_manifest["datasetId"],
        "rankingDatabaseSha256": ranking_manifest["databaseSha256"],
        "rankingTargetPolicy": data.target_policy,
        "modelFamily": model_family,
        "relevanceLevels": metrics["relevanceLevels"],
        "labelGainPolicy": metrics["labelGainPolicy"],
        "featureNames": MODEL_FEATURE_NAMES,
        "libraryVersions": {
            "numpy": np.__version__,
            "scikitLearn": sklearn.__version__,
            "lightgbm": lightgbm.__version__,
            "joblib": joblib.__version__,
        },
        "metrics": metrics,
        "releaseStatus": "UNAVAILABLE",
        "releaseBlockers": [
            "MINUTE_EXECUTION_BACKTEST_PENDING",
            "AGENT_BUNDLE_MISSING",
            "JOINT_ABLATION_PENDING",
        ],
    }
    temporary = manifest_path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    os.replace(temporary, manifest_path)
    return manifest
