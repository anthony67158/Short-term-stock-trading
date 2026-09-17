"""Freeze and evaluate zero-shot time-series foundation-model teachers."""

import argparse
import hashlib
import json
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.stats import rankdata
from sklearn.metrics import log_loss, mean_pinball_loss

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
from platform_app.modules.experiments.probabilistic_baseline_runner import (
    fee_adjusted_returns,
)
from platform_app.modules.experiments.ranking_model_trainer import (
    BOARD_CODES,
    _verified_ranking_database,
)

SCHEMA_VERSION = "foundation-teacher-screening.v2"
DATASET_SCHEMA_VERSION = "foundation-teacher-screening-dataset.v2"
DEFAULT_CONTEXT_LENGTH = 90
DEFAULT_FORECAST_HORIZON = 5
DEFAULT_SAMPLES_PER_PARTITION = 2_048
DEFAULT_BATCH_SIZE = 32
SCREENING_FOLDS = (1, 2)
SCREENING_PARTITIONS = ("probabilityCalibration", "test")
PARTITION_RANGES = {
    "probabilityCalibration": (
        "probabilityCalibrationStart",
        "probabilityCalibrationEnd",
    ),
    "test": ("testStart", "testEnd"),
}
MODEL_SPECS = {
    "ttm-r2.1": {
        "modelId": "ibm-granite/granite-timeseries-ttm-r2",
        "revision": "cd2ad2a54ba5531fbcf6ba3b7a763a6e14223680",
        "runtime": "granite-tsfm==0.2.28",
        "nativeQuantiles": [],
        "contextLimit": 90,
        "forecastLimit": 30,
        "officialSource": (
            "https://huggingface.co/ibm-granite/"
            "granite-timeseries-ttm-r2"
        ),
    },
    "timesfm-2.5": {
        "modelId": "google/timesfm-2.5-200m-pytorch",
        "revision": "1d952420fba87f3c6dee4f240de0f1a0fbc790e3",
        "runtime": "timesfm[torch]==2.0.2",
        "nativeQuantiles": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
        "contextLimit": 16_384,
        "forecastLimit": 1_024,
        "officialSource": (
            "https://huggingface.co/google/timesfm-2.5-200m-pytorch"
        ),
    },
    "chronos-2": {
        "modelId": "amazon/chronos-2",
        "revision": "29ec3766d36d6f73f0696f85560a422f50e8498c",
        "runtime": "chronos-forecasting==2.3.2",
        "nativeQuantiles": list(DEFAULT_QUANTILES),
        "contextLimit": 8_192,
        "forecastLimit": 1_024,
        "officialSource": "https://huggingface.co/amazon/chronos-2",
    },
}
SCREENING_QUANTILES = (0.10, 0.25, 0.50, 0.75, 0.90)


class FoundationTeacherError(ValueError):
    pass


@dataclass(frozen=True)
class TeacherDataset:
    contexts: np.ndarray
    actual_return: np.ndarray
    dates: np.ndarray
    instruments: np.ndarray
    boards: np.ndarray
    sample_weight: np.ndarray
    forecast_steps: np.ndarray
    folds: np.ndarray
    partitions: np.ndarray

    def __post_init__(self) -> None:
        rows = len(self.contexts)
        if (
            rows == 0
            or self.contexts.shape != (rows, DEFAULT_CONTEXT_LENGTH)
            or any(
                len(values) != rows
                for values in (
                    self.actual_return,
                    self.dates,
                    self.instruments,
                    self.boards,
                    self.sample_weight,
                    self.forecast_steps,
                    self.folds,
                    self.partitions,
                )
            )
            or not np.all(np.isfinite(self.contexts))
            or not np.all(np.isfinite(self.actual_return))
            or np.any(self.sample_weight <= 0)
            or np.any(self.forecast_steps < 1)
            or np.any(self.forecast_steps > DEFAULT_FORECAST_HORIZON)
        ):
            raise FoundationTeacherError(
                "FOUNDATION_TEACHER_DATASET_INVALID",
            )


@dataclass(frozen=True)
class TeacherRawForecast:
    point: np.ndarray
    quantiles: np.ndarray
    quantile_levels: tuple[float, ...]
    inference_seconds: float

    def __post_init__(self) -> None:
        if (
            self.point.ndim != 2
            or self.point.shape[1] != DEFAULT_FORECAST_HORIZON
            or self.quantiles.shape
            != (
                len(self.point),
                DEFAULT_FORECAST_HORIZON,
                len(self.quantile_levels),
            )
            or not np.all(np.isfinite(self.point))
            or not np.all(np.isfinite(self.quantiles))
            or tuple(sorted(set(self.quantile_levels)))
            != self.quantile_levels
            or self.inference_seconds < 0
        ):
            raise FoundationTeacherError(
                "FOUNDATION_TEACHER_RAW_FORECAST_INVALID",
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
            raise FoundationTeacherError(
                f"FOUNDATION_TEACHER_ARTIFACT_MISMATCH:{path.name}",
            )
        return
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(rendered)
    os.replace(temporary, path)


def _score(fold: int, partition: str, date: str, instrument: str) -> bytes:
    return hashlib.sha256(
        f"foundation-teacher-v2:{fold}:{partition}:{date}:{instrument}".encode(),
    ).digest()


def _daily_quotas(dates: list[str], total: int) -> dict[str, int]:
    if not dates or total < len(dates):
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_SAMPLE_BUDGET_INVALID",
        )
    base, remainder = divmod(total, len(dates))
    return {
        date: base + int(index < remainder)
        for index, date in enumerate(dates)
    }


def _mature_return_context(
    ranking: sqlite3.Connection,
    *,
    instrument_id: str,
    decision_date: str,
    context_length: int = DEFAULT_CONTEXT_LENGTH,
) -> tuple[np.ndarray, int] | None:
    rows = ranking.execute(
        "SELECT decision_date, board, execution_date, terminal_date, "
        "forward_return_next_open_5 FROM ranking_samples "
        "WHERE instrument_id = ? AND decision_date < ? AND terminal_date <= ? "
        "ORDER BY decision_date DESC LIMIT ?",
        (instrument_id, decision_date, decision_date, context_length),
    ).fetchall()
    if len(rows) != context_length:
        return None
    rows = list(reversed(rows))
    values = fee_adjusted_returns(
        np.asarray([float(row["forward_return_next_open_5"]) for row in rows]),
        np.asarray([row["board"] for row in rows]),
        np.asarray([row["execution_date"] for row in rows]),
        np.asarray([row["terminal_date"] for row in rows]),
    )
    forecast_step = ranking.execute(
        "SELECT COUNT(*) FROM ranking_samples "
        "WHERE instrument_id = ? AND decision_date > ? AND decision_date <= ?",
        (instrument_id, rows[-1]["decision_date"], decision_date),
    ).fetchone()[0]
    if not 1 <= forecast_step <= DEFAULT_FORECAST_HORIZON:
        return None
    return values.astype(np.float32), forecast_step


def _partition_samples(
    ranking: sqlite3.Connection,
    *,
    fold: int,
    partition: str,
    start: str,
    end: str,
    samples: int,
) -> TeacherDataset:
    dates = [
        row[0]
        for row in ranking.execute(
            "SELECT DISTINCT decision_date FROM ranking_samples "
            "WHERE decision_date BETWEEN ? AND ? ORDER BY decision_date",
            (start, end),
        )
    ]
    quotas = _daily_quotas(dates, samples)
    records = []
    for date in dates:
        candidates = ranking.execute(
            "SELECT instrument_id, decision_date, board, execution_date, terminal_date, "
            "forward_return_next_open_5 FROM ranking_samples "
            "WHERE decision_date = ? ORDER BY instrument_id",
            (date,),
        ).fetchall()
        candidates.sort(
            key=lambda row: _score(
                fold,
                partition,
                date,
                row["instrument_id"],
            )
        )
        selected = []
        for row in candidates:
            context_result = _mature_return_context(
                ranking,
                instrument_id=row["instrument_id"],
                decision_date=date,
            )
            if context_result is None:
                continue
            context, forecast_step = context_result
            target = fee_adjusted_returns(
                np.asarray([float(row["forward_return_next_open_5"])]),
                np.asarray([row["board"]]),
                np.asarray([row["execution_date"]]),
                np.asarray([row["terminal_date"]]),
            )[0]
            selected.append((row, context, target, forecast_step))
            if len(selected) == quotas[date]:
                break
        if len(selected) != quotas[date]:
            raise FoundationTeacherError(
                "FOUNDATION_TEACHER_CONTEXT_SUPPORT_INSUFFICIENT",
            )
        weight = 1.0 / len(selected)
        records.extend(
            (row, context, target, weight, forecast_step)
            for row, context, target, forecast_step in selected
        )
    return TeacherDataset(
        contexts=np.stack([item[1] for item in records]),
        actual_return=np.asarray([item[2] for item in records], dtype=np.float32),
        dates=np.asarray([int(item[0]["decision_date"]) for item in records]),
        instruments=np.asarray(
            [item[0]["instrument_id"].encode() for item in records],
            dtype="S9",
        ),
        boards=np.asarray(
            [BOARD_CODES[item[0]["board"]] for item in records],
            dtype=np.int8,
        ),
        sample_weight=np.asarray([item[3] for item in records]),
        forecast_steps=np.asarray([item[4] for item in records], dtype=np.int8),
        folds=np.full(len(records), fold, dtype=np.int8),
        partitions=np.full(len(records), partition.encode(), dtype="S24"),
    )


def export_teacher_dataset(
    *,
    experiment_root: Path,
    foundation_root: Path,
    sampling_root: Path,
    ranking_root: Path,
    output_root: Path,
    samples_per_partition: int = DEFAULT_SAMPLES_PER_PARTITION,
) -> dict:
    experiment = load_frozen_experiment(experiment_root)
    foundation, _ = verify_foundation_return_dataset(foundation_root)
    sampling, _ = verify_foundation_sampling_dataset(sampling_root)
    ranking, ranking_database = _verified_ranking_database(ranking_root)
    if (
        experiment.dataset.database_sha256 != foundation["databaseSha256"]
        or experiment.dataset.sampling_database_sha256
        != sampling["databaseSha256"]
        or foundation["rankingDataset"]["databaseSha256"]
        != ranking["databaseSha256"]
    ):
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_LINEAGE_MISMATCH",
        )
    folds = {int(item["fold"]): item for item in sampling["folds"]}
    connection = sqlite3.connect(
        f"{ranking_database.resolve().as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    datasets = []
    try:
        for fold in SCREENING_FOLDS:
            contract = folds[fold]
            for partition in SCREENING_PARTITIONS:
                start_key, end_key = PARTITION_RANGES[partition]
                datasets.append(
                    _partition_samples(
                        connection,
                        fold=fold,
                        partition=partition,
                        start=contract[start_key],
                        end=contract[end_key],
                        samples=samples_per_partition,
                    )
                )
    finally:
        connection.close()
    combined = TeacherDataset(
        **{
            field: np.concatenate(
                [getattr(dataset, field) for dataset in datasets]
            )
            for field in TeacherDataset.__dataclass_fields__
        }
    )
    output_root.mkdir(parents=True, exist_ok=True)
    data_path = output_root / "teacher-data.npz"
    temporary = data_path.with_suffix(".npz.tmp")
    with temporary.open("wb") as stream:
        np.savez_compressed(
            stream,
            contexts=combined.contexts,
            actualReturn=combined.actual_return,
            dates=combined.dates,
            instruments=combined.instruments,
            boards=combined.boards,
            sampleWeight=combined.sample_weight,
            forecastSteps=combined.forecast_steps,
            folds=combined.folds,
            partitions=combined.partitions,
        )
    os.replace(temporary, data_path)
    manifest = {
        "schemaVersion": DATASET_SCHEMA_VERSION,
        "experimentId": experiment_id(experiment),
        "experimentConfigSha256": experiment_config_sha256(experiment),
        "foundationDatabaseSha256": foundation["databaseSha256"],
        "samplingDatabaseSha256": sampling["databaseSha256"],
        "rankingDatabaseSha256": ranking["databaseSha256"],
        "data": data_path.name,
        "dataSha256": _file_sha256(data_path),
        "rows": len(combined.contexts),
        "samplesPerPartition": samples_per_partition,
        "folds": list(SCREENING_FOLDS),
        "partitions": list(SCREENING_PARTITIONS),
        "contextLength": DEFAULT_CONTEXT_LENGTH,
        "forecastHorizon": DEFAULT_FORECAST_HORIZON,
        "forecastStepCounts": {
            str(step): int(np.sum(combined.forecast_steps == step))
            for step in np.unique(combined.forecast_steps)
        },
        "target": "r_net_5d",
        "contextPolicy": (
            "LAST_90_MATURED_R_NET_5D_WITH_TERMINAL_DATE_NOT_AFTER_DECISION"
        ),
        "selection": "EQUAL_DATE_LOWEST_SHA256_WITHOUT_TARGET_ACCESS",
    }
    _write_json(output_root / "data-manifest.json", manifest, immutable=True)
    return manifest


def load_teacher_dataset(root: Path) -> tuple[TeacherDataset, dict]:
    try:
        manifest = json.loads((root / "data-manifest.json").read_text())
        data_path = root / manifest["data"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_DATASET_NOT_SEALED",
        ) from exc
    if (
        manifest.get("schemaVersion") != DATASET_SCHEMA_VERSION
        or not data_path.is_file()
        or _file_sha256(data_path) != manifest.get("dataSha256")
    ):
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_DATASET_INVALID",
        )
    with np.load(data_path, allow_pickle=False) as saved:
        dataset = TeacherDataset(
            contexts=saved["contexts"].copy(),
            actual_return=saved["actualReturn"].copy(),
            dates=saved["dates"].copy(),
            instruments=saved["instruments"].copy(),
            boards=saved["boards"].copy(),
            sample_weight=saved["sampleWeight"].copy(),
            forecast_steps=saved["forecastSteps"].copy(),
            folds=saved["folds"].copy(),
            partitions=saved["partitions"].copy(),
        )
    if len(dataset.contexts) != manifest["rows"]:
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_DATASET_COUNT_MISMATCH",
        )
    return dataset, manifest


def select_forecast_steps(
    values: np.ndarray,
    forecast_steps: np.ndarray,
) -> np.ndarray:
    array = np.asarray(values)
    steps = np.asarray(forecast_steps, dtype=np.int64)
    if (
        array.ndim not in (2, 3)
        or len(array) != len(steps)
        or array.shape[1] != DEFAULT_FORECAST_HORIZON
        or np.any(steps < 1)
        or np.any(steps > DEFAULT_FORECAST_HORIZON)
    ):
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_FORECAST_STEP_INVALID",
        )
    return array[np.arange(len(array)), steps - 1]


def _weighted_residual_quantiles(
    residuals: np.ndarray,
    weights: np.ndarray,
) -> np.ndarray:
    values = np.asarray(residuals, dtype=np.float64)
    sample_weight = np.asarray(weights, dtype=np.float64)
    if (
        values.ndim != 1
        or len(values) != len(sample_weight)
        or len(values) == 0
        or np.any(sample_weight <= 0)
        or not np.all(np.isfinite(values))
        or not np.all(np.isfinite(sample_weight))
    ):
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_RESIDUALS_INVALID",
        )
    order = np.argsort(values, kind="stable")
    cumulative = np.cumsum(sample_weight[order])
    indices = np.searchsorted(
        cumulative,
        np.asarray(SCREENING_QUANTILES) * cumulative[-1],
        side="left",
    )
    return values[order][np.minimum(indices, len(values) - 1)]


def _empirical_win_probability(
    point: np.ndarray,
    calibration_residuals: np.ndarray,
    calibration_weights: np.ndarray,
) -> np.ndarray:
    residuals = np.asarray(calibration_residuals, dtype=np.float64)
    weights = np.asarray(calibration_weights, dtype=np.float64)
    order = np.argsort(residuals, kind="stable")
    ordered = residuals[order]
    cumulative = np.cumsum(weights[order])
    thresholds = -np.asarray(point, dtype=np.float64)
    left = np.searchsorted(ordered, thresholds, side="right")
    below = np.where(left == 0, 0.0, cumulative[left - 1])
    return np.clip(1.0 - below / cumulative[-1], 0.0, 1.0)


def common_quantile_predictions(
    *,
    model_name: str,
    selected_point: np.ndarray,
    selected_native_quantiles: np.ndarray,
    native_levels: tuple[float, ...],
    calibration_residual_quantiles: np.ndarray,
) -> np.ndarray:
    point = np.asarray(selected_point, dtype=np.float64)
    if model_name == "ttm-r2.1":
        result = point[:, None] + calibration_residual_quantiles[None, :]
    else:
        native = np.asarray(selected_native_quantiles, dtype=np.float64)
        if (
            native.shape != (len(point), len(native_levels))
            or len(native_levels) == 0
        ):
            raise FoundationTeacherError(
                "FOUNDATION_TEACHER_NATIVE_QUANTILES_INVALID",
            )
        result = np.column_stack(
            [
                np.asarray(
                    [
                        np.interp(level, native_levels, row)
                        for row in native
                    ]
                )
                for level in SCREENING_QUANTILES
            ]
        )
    return np.sort(result, axis=1).astype(np.float32)


def _interval_score(
    actual: np.ndarray,
    lower: np.ndarray,
    upper: np.ndarray,
    alpha: float,
) -> np.ndarray:
    return (
        upper
        - lower
        + (2.0 / alpha) * np.maximum(lower - actual, 0.0)
        + (2.0 / alpha) * np.maximum(actual - upper, 0.0)
    )


def _teacher_ranking_metrics(
    dates: np.ndarray,
    actual: np.ndarray,
    scores: np.ndarray,
) -> dict:
    rank_ic = []
    top10 = []
    market = []
    for date in np.unique(dates):
        mask = dates == date
        date_actual = actual[mask]
        date_scores = scores[mask]
        if len(date_actual) < 2 or np.ptp(date_scores) == 0:
            rank_ic.append(0.0)
        else:
            rank_ic.append(
                float(
                    np.corrcoef(
                        rankdata(date_scores, method="average"),
                        rankdata(date_actual, method="average"),
                    )[0, 1]
                )
            )
        selected = np.argsort(date_scores)[-min(10, len(date_scores)) :]
        top10.append(float(np.mean(date_actual[selected])))
        market.append(float(np.mean(date_actual)))
    return {
        "meanDailyRankIc": float(np.mean(rank_ic)),
        "top10MeanNetReturn": float(np.mean(top10)),
        "marketMeanNetReturn": float(np.mean(market)),
        "top10NetReturnIncrement": float(np.mean(top10) - np.mean(market)),
    }


def evaluate_teacher_test(
    dataset: TeacherDataset,
    raw: TeacherRawForecast,
    *,
    model_name: str,
    fold: int,
) -> tuple[dict, dict[str, np.ndarray]]:
    calibration = (dataset.folds == fold) & (
        dataset.partitions == b"probabilityCalibration"
    )
    test = (dataset.folds == fold) & (dataset.partitions == b"test")
    if not np.any(calibration) or not np.any(test):
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_EVALUATION_PARTITION_MISSING",
        )
    selected_point = select_forecast_steps(raw.point, dataset.forecast_steps)
    if raw.quantiles.shape[2]:
        selected_native = select_forecast_steps(
            raw.quantiles,
            dataset.forecast_steps,
        )
    else:
        selected_native = np.empty((len(dataset.contexts), 0))
    residuals = dataset.actual_return[calibration] - selected_point[calibration]
    residual_quantiles = _weighted_residual_quantiles(
        residuals,
        dataset.sample_weight[calibration],
    )
    quantiles = common_quantile_predictions(
        model_name=model_name,
        selected_point=selected_point,
        selected_native_quantiles=selected_native,
        native_levels=raw.quantile_levels,
        calibration_residual_quantiles=residual_quantiles,
    )
    probability = _empirical_win_probability(
        selected_point,
        residuals,
        dataset.sample_weight[calibration],
    )
    actual = dataset.actual_return[test].astype(np.float64)
    weights = dataset.sample_weight[test].astype(np.float64)
    weights /= np.mean(weights)
    predicted = quantiles[test].astype(np.float64)
    p_win = np.clip(probability[test], 1e-7, 1 - 1e-7)
    direction = (actual > 0).astype(np.int8)
    pinball = {
        f"q{round(level * 100):02d}": float(
            mean_pinball_loss(
                actual,
                predicted[:, index],
                alpha=level,
                sample_weight=weights,
            )
        )
        for index, level in enumerate(SCREENING_QUANTILES)
    }
    wis = (
        0.5 * np.abs(actual - predicted[:, 2])
        + 0.1
        * _interval_score(actual, predicted[:, 0], predicted[:, 4], 0.2)
        + 0.25
        * _interval_score(actual, predicted[:, 1], predicted[:, 3], 0.5)
    ) / 2.5
    covered80 = (actual >= predicted[:, 0]) & (actual <= predicted[:, 4])
    metrics = {
        "fold": fold,
        "model": model_name,
        "samples": int(np.sum(test)),
        "dates": int(len(np.unique(dataset.dates[test]))),
        "brier": float(np.average((p_win - direction) ** 2, weights=weights)),
        "logLoss": float(
            log_loss(
                direction,
                p_win,
                labels=[0, 1],
                sample_weight=weights,
            )
        ),
        "pinball": pinball,
        "meanPinball": float(np.mean(tuple(pinball.values()))),
        "weightedIntervalScore80": float(np.average(wis, weights=weights)),
        "interval80Coverage": float(np.average(covered80, weights=weights)),
        "interval80MeanWidth": float(
            np.average(predicted[:, 4] - predicted[:, 0], weights=weights)
        ),
        "ranking": _teacher_ranking_metrics(
            dataset.dates[test],
            actual,
            predicted[:, 2],
        ),
        "probabilityCalibration": (
            "WEIGHTED_EMPIRICAL_POINT_RESIDUAL_CDF"
        ),
        "quantilePolicy": (
            "WEIGHTED_EMPIRICAL_POINT_RESIDUALS"
            if model_name == "ttm-r2.1"
            else "NATIVE_WITHIN_RANGE_LINEAR_INTERPOLATION"
        ),
    }
    predictions = {
        "dates": dataset.dates[test],
        "instruments": dataset.instruments[test],
        "actualReturn": dataset.actual_return[test],
        "sampleWeight": dataset.sample_weight[test],
        "pWin": probability[test].astype(np.float32),
        **{
            f"q{round(level * 100):02d}": quantiles[test, index]
            for index, level in enumerate(SCREENING_QUANTILES)
        },
    }
    return metrics, predictions


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--experiment-root", type=Path, required=True)
    parser.add_argument("--foundation-root", type=Path, required=True)
    parser.add_argument("--sampling-root", type=Path, required=True)
    parser.add_argument("--ranking-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--samples-per-partition",
        type=int,
        default=DEFAULT_SAMPLES_PER_PARTITION,
    )
    args = parser.parse_args()
    result = export_teacher_dataset(
        experiment_root=args.experiment_root,
        foundation_root=args.foundation_root,
        sampling_root=args.sampling_root,
        ranking_root=args.ranking_root,
        output_root=args.output,
        samples_per_partition=args.samples_per_partition,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
