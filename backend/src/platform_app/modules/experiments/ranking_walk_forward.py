"""Strict expanding walk-forward evaluation for full-universe rankers."""

import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from lightgbm import LGBMRanker, early_stopping, log_evaluation
from sklearn.ensemble import HistGradientBoostingRegressor

from platform_app.modules.experiments.quant_model_trainer import (
    EMBARGO_SESSIONS,
    RANDOM_STATE,
    QuantModelError,
    temporal_split,
)
from platform_app.modules.experiments.ranking_model_trainer import (
    BOARD_CODES,
    DEFAULT_RELEVANCE_LEVELS,
    GLOBAL_PERCENTILE_TARGET,
    LINEAR_LABEL_GAIN_POLICY,
    MODEL_FEATURE_NAMES,
    RankingTrainingData,
    _daily_backtest_metrics,
    _file_sha256,
    _group_sizes,
    _linear_label_gain,
    _percentile_ranks,
    _relevance_labels,
)

SCHEMA_VERSION = "ranking-walk-forward.v1"
FOLD_COUNT = 5
MINIMUM_TEST_SESSIONS = 63
CALIBRATION_SESSIONS = 126
PURGE_SESSIONS = 5
BOOTSTRAP_BLOCK_SESSIONS = 10
BOOTSTRAP_ITERATIONS = 2000


@dataclass(frozen=True)
class WalkForwardFold:
    fold: int
    train_end: int
    calibration_start: int
    calibration_end: int
    test_start: int
    test_end: int

    def masks(self, dates: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        return (
            dates <= self.train_end,
            (dates >= self.calibration_start) & (dates <= self.calibration_end),
            (dates >= self.test_start) & (dates <= self.test_end),
        )

    def as_dict(self) -> dict:
        return {
            "fold": self.fold,
            "trainEnd": str(self.train_end),
            "calibrationStart": str(self.calibration_start),
            "calibrationEnd": str(self.calibration_end),
            "testStart": str(self.test_start),
            "testEnd": str(self.test_end),
            "purgeSessions": PURGE_SESSIONS,
            "embargoSessions": EMBARGO_SESSIONS,
        }


def expanding_walk_forward_splits(
    dates: np.ndarray,
    *,
    fold_count: int = FOLD_COUNT,
    calibration_sessions: int = CALIBRATION_SESSIONS,
) -> list[WalkForwardFold]:
    unique = np.unique(dates)
    if fold_count < 2 or calibration_sessions < MINIMUM_TEST_SESSIONS:
        raise QuantModelError("WALK_FORWARD_PROTOCOL_INVALID")
    first_test = temporal_split(dates).confirmation_start
    test_dates = unique[unique >= first_test]
    if len(test_dates) < fold_count * MINIMUM_TEST_SESSIONS:
        raise QuantModelError("WALK_FORWARD_TEST_SUPPORT_INSUFFICIENT")

    blocks = np.array_split(test_dates, fold_count)
    folds = []
    for fold_number, block in enumerate(blocks, 1):
        test_start_index = int(np.searchsorted(unique, block[0]))
        calibration_end_index = test_start_index - EMBARGO_SESSIONS - 1
        calibration_start_index = calibration_end_index - calibration_sessions + 1
        train_end_index = calibration_start_index - PURGE_SESSIONS - 1
        if train_end_index < 0:
            raise QuantModelError("WALK_FORWARD_TRAIN_SUPPORT_INSUFFICIENT")
        folds.append(
            WalkForwardFold(
                fold=fold_number,
                train_end=int(unique[train_end_index]),
                calibration_start=int(unique[calibration_start_index]),
                calibration_end=int(unique[calibration_end_index]),
                test_start=int(block[0]),
                test_end=int(block[-1]),
            )
        )
    return folds


def _board_target_rank(data: RankingTrainingData) -> np.ndarray:
    target = np.empty(len(data.dates), dtype=np.float32)
    _, starts, counts = np.unique(data.dates, return_index=True, return_counts=True)
    for start, count in zip(starts, counts, strict=True):
        date_slice = slice(start, start + count)
        date_boards = data.boards[date_slice]
        date_returns = data.target_return[date_slice]
        for board_code in BOARD_CODES.values():
            local = np.flatnonzero(date_boards == board_code)
            target[start + local] = _percentile_ranks(date_returns[local])
    return target


def _fit_candidate(
    data: RankingTrainingData,
    train: np.ndarray,
    calibration: np.ndarray,
    *,
    max_iter: int,
    min_samples_leaf: int,
    relevance_levels: int,
):
    model = LGBMRanker(
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
    return model.fit(
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


def _fit_baseline(
    data: RankingTrainingData,
    board_target: np.ndarray,
    train: np.ndarray,
    *,
    max_iter: int,
    min_samples_leaf: int,
):
    return HistGradientBoostingRegressor(
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
        board_target[train],
        sample_weight=data.sample_weight[train],
    )


def _selection_records(
    dates: np.ndarray,
    boards: np.ndarray,
    instruments: np.ndarray,
    returns: np.ndarray,
    candidate_scores: np.ndarray,
    baseline_scores: np.ndarray,
) -> list[dict]:
    records = []
    previous_candidate: set[bytes] | None = None
    previous_baseline: set[bytes] | None = None
    for decision_date in np.unique(dates):
        mask = dates == decision_date
        local_returns = returns[mask]
        local_boards = boards[mask]
        local_instruments = instruments[mask]
        candidate = np.argsort(candidate_scores[mask])[-min(10, np.sum(mask)) :]
        baseline = np.argsort(baseline_scores[mask])[-min(10, np.sum(mask)) :]
        candidate_ids = set(local_instruments[candidate])
        baseline_ids = set(local_instruments[baseline])
        record = {
            "date": int(decision_date),
            "candidateMean": float(np.mean(local_returns[candidate])),
            "baselineMean": float(np.mean(local_returns[baseline])),
            "candidateTurnover": (
                None
                if previous_candidate is None
                else 1 - len(candidate_ids & previous_candidate) / len(candidate_ids)
            ),
            "baselineTurnover": (
                None
                if previous_baseline is None
                else 1 - len(baseline_ids & previous_baseline) / len(baseline_ids)
            ),
            "boards": {},
        }
        for board, code in BOARD_CODES.items():
            candidate_values = local_returns[candidate][local_boards[candidate] == code]
            baseline_values = local_returns[baseline][local_boards[baseline] == code]
            record["boards"][board] = {
                "candidateContribution": float(np.sum(candidate_values) / 10),
                "baselineContribution": float(np.sum(baseline_values) / 10),
                "candidateSelections": int(len(candidate_values)),
                "baselineSelections": int(len(baseline_values)),
            }
        records.append(record)
        previous_candidate = candidate_ids
        previous_baseline = baseline_ids
    return records


def block_bootstrap_interval(
    values: np.ndarray,
    *,
    block_sessions: int = BOOTSTRAP_BLOCK_SESSIONS,
    iterations: int = BOOTSTRAP_ITERATIONS,
    seed: int = RANDOM_STATE,
) -> dict:
    values = np.asarray(values, dtype=np.float64)
    if len(values) < block_sessions or iterations <= 0:
        raise QuantModelError("WALK_FORWARD_BOOTSTRAP_SUPPORT_INSUFFICIENT")
    rng = np.random.default_rng(seed)
    starts = np.arange(len(values))
    estimates = np.empty(iterations, dtype=np.float64)
    block_count = int(np.ceil(len(values) / block_sessions))
    offsets = np.arange(block_sessions)
    for index in range(iterations):
        sampled_starts = rng.choice(starts, size=block_count, replace=True)
        sampled = np.concatenate(
            [values[(start + offsets) % len(values)] for start in sampled_starts]
        )[: len(values)]
        estimates[index] = np.mean(sampled)
    return {
        "observedMean": float(np.mean(values)),
        "oneSided95Lower": float(np.quantile(estimates, 0.05)),
        "twoSided95Lower": float(np.quantile(estimates, 0.025)),
        "twoSided95Upper": float(np.quantile(estimates, 0.975)),
        "blockSessions": block_sessions,
        "iterations": iterations,
    }


def _aggregate_records(records: list[dict]) -> dict:
    differences = np.asarray(
        [row["candidateMean"] - row["baselineMean"] for row in records]
    )
    candidate_turnover = [
        row["candidateTurnover"]
        for row in records
        if row["candidateTurnover"] is not None
    ]
    baseline_turnover = [
        row["baselineTurnover"]
        for row in records
        if row["baselineTurnover"] is not None
    ]
    return {
        "testDates": len(records),
        "candidateTop10MeanGrossReturn": float(
            np.mean([row["candidateMean"] for row in records])
        ),
        "baselineTop10MeanGrossReturn": float(
            np.mean([row["baselineMean"] for row in records])
        ),
        "candidateTop10MeanReturnAt10BpsStress": float(
            np.mean([row["candidateMean"] for row in records]) - 0.001
        ),
        "meanDailyTurnover": {
            "candidate": float(np.mean(candidate_turnover)),
            "baseline": float(np.mean(baseline_turnover)),
        },
        "candidateMinusBaseline": block_bootstrap_interval(differences),
    }


def _strata(records: list[dict]) -> dict:
    years = {}
    for year in sorted({str(row["date"])[:4] for row in records}):
        subset = [row for row in records if str(row["date"]).startswith(year)]
        if len(subset) >= BOOTSTRAP_BLOCK_SESSIONS:
            years[year] = _aggregate_records(subset)
    boards = {}
    for board in BOARD_CODES:
        differences = np.asarray(
            [
                row["boards"][board]["candidateContribution"]
                - row["boards"][board]["baselineContribution"]
                for row in records
            ]
        )
        boards[board] = {
            "candidateSelections": sum(
                row["boards"][board]["candidateSelections"] for row in records
            ),
            "baselineSelections": sum(
                row["boards"][board]["baselineSelections"] for row in records
            ),
            "candidateMinusBaselineDailyContribution": block_bootstrap_interval(
                differences
            ),
        }
    return {"years": years, "boards": boards}


def _fold_stability(folds: list[dict]) -> dict:
    def summarize(values: list[float]) -> dict:
        array = np.asarray(values, dtype=np.float64)
        return {
            "mean": float(np.mean(array)),
            "median": float(np.median(array)),
            "worst": float(np.min(array)),
            "standardDeviation": float(np.std(array)),
        }

    return {
        "candidateMeanDailyRankIc": summarize(
            [fold["candidate"]["meanDailyRankIc"] for fold in folds]
        ),
        "candidateTop10MeanGrossReturn": summarize(
            [fold["comparison"]["candidateTop10MeanGrossReturn"] for fold in folds]
        ),
        "candidateMinusBaselineDailyReturn": summarize(
            [
                fold["comparison"]["candidateMinusBaseline"]["observedMean"]
                for fold in folds
            ]
        ),
    }


def _walk_forward_protocol(*, max_iter: int, relevance_levels: int) -> dict:
    if relevance_levels < 2:
        raise QuantModelError("RANKING_RELEVANCE_LEVELS_INVALID")
    return {
        "foldCount": FOLD_COUNT,
        "minimumTestSessions": MINIMUM_TEST_SESSIONS,
        "calibrationSessions": CALIBRATION_SESSIONS,
        "purgeSessions": PURGE_SESSIONS,
        "embargoSessions": EMBARGO_SESSIONS,
        "bootstrapBlockSessions": BOOTSTRAP_BLOCK_SESSIONS,
        "bootstrapIterations": BOOTSTRAP_ITERATIONS,
        "candidate": "global-percentile-v2/lightgbm-lambdarank-v1",
        "baseline": "board-percentile-v1/hgb-mse-v1",
        "relevanceLevels": relevance_levels,
        "labelGainPolicy": LINEAR_LABEL_GAIN_POLICY,
        "maxIterations": max_iter,
        "randomState": RANDOM_STATE,
        "hyperparameterTrials": 1,
        "selectionRule": "PRE_REGISTERED_FIXED_CONFIGURATION",
    }


def evaluate_ranking_walk_forward(
    data: RankingTrainingData,
    *,
    ranking_manifest: dict,
    output_path: Path,
    max_iter: int = 120,
    min_samples_leaf: int = 200,
    relevance_levels: int = DEFAULT_RELEVANCE_LEVELS,
) -> dict:
    if data.target_policy != GLOBAL_PERCENTILE_TARGET:
        raise QuantModelError("WALK_FORWARD_REQUIRES_GLOBAL_TARGET")
    protocol = _walk_forward_protocol(
        max_iter=max_iter,
        relevance_levels=relevance_levels,
    )
    folds = expanding_walk_forward_splits(data.dates)
    board_target = _board_target_rank(data)
    fold_reports = []
    all_records = []
    for fold in folds:
        train, calibration, test = fold.masks(data.dates)
        candidate = _fit_candidate(
            data,
            train,
            calibration,
            max_iter=max_iter,
            min_samples_leaf=min_samples_leaf,
            relevance_levels=relevance_levels,
        )
        baseline = _fit_baseline(
            data,
            board_target,
            train,
            max_iter=max_iter,
            min_samples_leaf=min_samples_leaf,
        )
        candidate_scores = candidate.predict(data.x[test])
        baseline_scores = baseline.predict(data.x[test])
        records = _selection_records(
            data.dates[test],
            data.boards[test],
            data.instruments[test],
            data.target_return[test],
            candidate_scores,
            baseline_scores,
        )
        all_records.extend(records)
        fold_reports.append(
            {
                **fold.as_dict(),
                "trainSamples": int(np.sum(train)),
                "calibrationSamples": int(np.sum(calibration)),
                "testSamples": int(np.sum(test)),
                "candidate": _daily_backtest_metrics(
                    data.dates[test],
                    data.boards[test],
                    data.target_return[test],
                    candidate_scores,
                ),
                "baseline": _daily_backtest_metrics(
                    data.dates[test],
                    data.boards[test],
                    data.target_return[test],
                    baseline_scores,
                ),
                "comparison": _aggregate_records(records),
            }
        )
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "createdAt": datetime.now(UTC).isoformat(),
        "rankingDatasetId": ranking_manifest["datasetId"],
        "rankingDatabaseSha256": ranking_manifest["databaseSha256"],
        "featureNames": MODEL_FEATURE_NAMES,
        "protocol": protocol,
        "folds": fold_reports,
        "foldStability": _fold_stability(fold_reports),
        "aggregate": _aggregate_records(all_records),
        "strata": _strata(all_records),
    }
    report["gate"] = {
        "meanDailyRankIcAtLeast00991": report["foldStability"][
            "candidateMeanDailyRankIc"
        ]["mean"]
        >= 0.0991,
        "relativeReturnOneSided95LowerAboveZero": report["aggregate"][
            "candidateMinusBaseline"
        ]["oneSided95Lower"]
        > 0,
    }
    target = output_path.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(
        json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    os.replace(temporary, target)
    report["reportSha256"] = _file_sha256(target)
    return report


__all__ = [
    "WalkForwardFold",
    "block_bootstrap_interval",
    "evaluate_ranking_walk_forward",
    "expanding_walk_forward_splits",
]
