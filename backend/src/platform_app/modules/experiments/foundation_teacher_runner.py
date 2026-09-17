"""Freeze and evaluate zero-shot time-series foundation-model teachers."""

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import sqlite3
import time
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
    FoundationReturnDatasetError,
    FoundationReturnDatasetReader,
)

SCHEMA_VERSION = "foundation-teacher-screening.v4"
DATASET_SCHEMA_VERSION = "foundation-teacher-screening-dataset.v4"
REFERENCE_NOTIONAL_CNY = 100_000.0
MARKET_EXIT_SLIPPAGE_RATE = 0.0005
BOARD_CODES = {"MAIN": 0, "CHINEXT": 1, "STAR": 2, "BEIJING": 3}
BOARD_NAMES = {code: name for name, code in BOARD_CODES.items()}
DEFAULT_CONTEXT_LENGTH = 90
DEFAULT_FORECAST_HORIZON = 5
DEFAULT_SAMPLES_PER_DATE = 50
MINIMUM_SAMPLES_PER_DATE = 20
DEFAULT_BATCH_SIZE = 32
TTM_DAILY_FREQUENCY_TOKEN = 8
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
        "frequency": "D",
        "frequencyToken": TTM_DAILY_FREQUENCY_TOKEN,
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
    reference_close: np.ndarray
    actual_return: np.ndarray
    dates: np.ndarray
    execution_dates: np.ndarray
    terminal_dates: np.ndarray
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
                    self.reference_close,
                    self.actual_return,
                    self.dates,
                    self.execution_dates,
                    self.terminal_dates,
                    self.instruments,
                    self.boards,
                    self.sample_weight,
                    self.forecast_steps,
                    self.folds,
                    self.partitions,
                )
            )
            or not np.all(np.isfinite(self.contexts))
            or not np.all(np.isfinite(self.reference_close))
            or not np.all(np.isfinite(self.actual_return))
            or np.any(self.contexts <= 0)
            or np.any(self.reference_close <= 0)
            or not np.allclose(
                self.contexts[:, -1],
                self.reference_close,
                rtol=1e-6,
                atol=1e-6,
            )
            or np.any(self.execution_dates <= self.dates)
            or np.any(self.terminal_dates < self.execution_dates)
            or not np.all(np.isin(self.boards, tuple(BOARD_NAMES)))
            or np.any(self.sample_weight <= 0)
            or np.any(self.forecast_steps != DEFAULT_FORECAST_HORIZON)
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


def _round_cny(values: np.ndarray) -> np.ndarray:
    cents = np.nextafter(values * 100.0 + 0.5, np.inf)
    return np.floor(cents) / 100.0


def fee_adjusted_returns(
    gross_returns: np.ndarray,
    boards: np.ndarray,
    execution_dates: np.ndarray,
    terminal_dates: np.ndarray,
) -> np.ndarray:
    gross = np.asarray(gross_returns, dtype=np.float64)
    board = np.asarray(boards)
    execution = np.asarray(execution_dates)
    terminal = np.asarray(terminal_dates)
    if (
        gross.ndim != 1
        or len({len(gross), len(board), len(execution), len(terminal)}) != 1
        or not np.all(np.isfinite(gross))
        or np.any(gross <= -1.0)
        or not np.all(np.isin(board, tuple(BOARD_CODES)))
    ):
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_LABEL_INPUT_INVALID",
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
    buy_fees = 30.0 + _round_cny(
        REFERENCE_NOTIONAL_CNY * buy_transfer_rate,
    )
    sell_gross = (
        REFERENCE_NOTIONAL_CNY
        * (1.0 + gross)
        * (1.0 - MARKET_EXIT_SLIPPAGE_RATE)
    )
    sell_fees = (
        _round_cny(np.maximum(5.0, sell_gross * 0.0003))
        + _round_cny(sell_gross * sell_transfer_rate)
        + _round_cny(sell_gross * stamp_rate)
    )
    return (
        sell_gross
        - sell_fees
        - REFERENCE_NOTIONAL_CNY
        - buy_fees
    ) / (REFERENCE_NOTIONAL_CNY + buy_fees)


def price_forecasts_to_fee_adjusted_returns(
    predicted_prices: np.ndarray,
    reference_close: np.ndarray,
    boards: np.ndarray,
    execution_dates: np.ndarray,
    terminal_dates: np.ndarray,
) -> np.ndarray:
    prices = np.asarray(predicted_prices, dtype=np.float64)
    reference = np.asarray(reference_close, dtype=np.float64)
    board_codes = np.asarray(boards)
    execution = np.asarray(execution_dates).astype("U8")
    terminal = np.asarray(terminal_dates).astype("U8")
    if (
        prices.ndim not in (1, 2)
        or prices.shape[0] != len(reference)
        or len({len(reference), len(board_codes), len(execution), len(terminal)})
        != 1
        or not np.all(np.isfinite(prices))
        or not np.all(np.isfinite(reference))
        or np.any(prices <= 0)
        or np.any(reference <= 0)
        or not np.all(np.isin(board_codes, tuple(BOARD_NAMES)))
    ):
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_PRICE_FORECAST_INVALID",
        )
    columns = 1 if prices.ndim == 1 else prices.shape[1]
    gross = prices / reference.reshape((-1,) + (1,) * (prices.ndim - 1)) - 1.0
    board_names = np.asarray([BOARD_NAMES[int(code)] for code in board_codes])
    adjusted = fee_adjusted_returns(
        gross.reshape(-1),
        np.repeat(board_names, columns),
        np.repeat(execution, columns),
        np.repeat(terminal, columns),
    )
    return adjusted.reshape(prices.shape)


def _score(fold: int, partition: str, date: str, instrument: str) -> bytes:
    return hashlib.sha256(
        f"foundation-teacher-v4:{fold}:{partition}:{date}:{instrument}".encode(),
    ).digest()


def _daily_quotas(
    dates: list[str],
    total: int,
    *,
    minimum_per_date: int = 1,
) -> dict[str, int]:
    if (
        not dates
        or minimum_per_date <= 0
        or total < len(dates) * minimum_per_date
    ):
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_SAMPLE_BUDGET_INVALID",
        )
    base, remainder = divmod(total, len(dates))
    return {
        date: base + int(index < remainder)
        for index, date in enumerate(dates)
    }


def _adjusted_close_context(
    reader: FoundationReturnDatasetReader,
    *,
    instrument_id: str,
    decision_date: str,
) -> tuple[np.ndarray, float] | None:
    try:
        history = reader.load_history_sequence(instrument_id, decision_date)
    except FoundationReturnDatasetError as exc:
        if str(exc) == "FOUNDATION_HISTORY_SEQUENCE_INCOMPLETE":
            return None
        raise
    values = np.asarray(
        [float(row["adjustedClose"]) for row in history["rows"]],
        dtype=np.float32,
    )
    if (
        values.shape != (DEFAULT_CONTEXT_LENGTH,)
        or not np.all(np.isfinite(values))
        or np.any(values <= 0)
    ):
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_PRICE_CONTEXT_INVALID",
        )
    return values, float(values[-1])


def _partition_samples(
    ranking: sqlite3.Connection,
    reader: FoundationReturnDatasetReader,
    *,
    fold: int,
    partition: str,
    start: str,
    end: str,
    samples_per_date: int = DEFAULT_SAMPLES_PER_DATE,
    minimum_per_date: int = MINIMUM_SAMPLES_PER_DATE,
) -> TeacherDataset:
    dates = [
        row[0]
        for row in ranking.execute(
            "SELECT DISTINCT decision_date FROM ranking_samples "
            "WHERE decision_date BETWEEN ? AND ? ORDER BY decision_date",
            (start, end),
        )
    ]
    if samples_per_date < minimum_per_date:
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_SAMPLE_BUDGET_INVALID",
        )
    quotas = _daily_quotas(
        dates,
        len(dates) * samples_per_date,
        minimum_per_date=minimum_per_date,
    )
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
            context_result = _adjusted_close_context(
                reader,
                instrument_id=row["instrument_id"],
                decision_date=date,
            )
            if context_result is None:
                continue
            context, reference_close = context_result
            target = fee_adjusted_returns(
                np.asarray([float(row["forward_return_next_open_5"])]),
                np.asarray([row["board"]]),
                np.asarray([row["execution_date"]]),
                np.asarray([row["terminal_date"]]),
            )[0]
            selected.append((row, context, reference_close, target))
            if len(selected) == quotas[date]:
                break
        if len(selected) != quotas[date]:
            raise FoundationTeacherError(
                "FOUNDATION_TEACHER_CONTEXT_SUPPORT_INSUFFICIENT",
            )
        weight = 1.0 / len(selected)
        records.extend(
            (row, context, reference_close, target, weight)
            for row, context, reference_close, target in selected
        )
    return TeacherDataset(
        contexts=np.stack([item[1] for item in records]),
        reference_close=np.asarray(
            [item[2] for item in records],
            dtype=np.float32,
        ),
        actual_return=np.asarray([item[3] for item in records], dtype=np.float32),
        dates=np.asarray([int(item[0]["decision_date"]) for item in records]),
        execution_dates=np.asarray(
            [int(item[0]["execution_date"]) for item in records],
            dtype=np.int32,
        ),
        terminal_dates=np.asarray(
            [int(item[0]["terminal_date"]) for item in records],
            dtype=np.int32,
        ),
        instruments=np.asarray(
            [item[0]["instrument_id"].encode() for item in records],
            dtype="S9",
        ),
        boards=np.asarray(
            [BOARD_CODES[item[0]["board"]] for item in records],
            dtype=np.int8,
        ),
        sample_weight=np.asarray([item[4] for item in records]),
        forecast_steps=np.full(
            len(records),
            DEFAULT_FORECAST_HORIZON,
            dtype=np.int8,
        ),
        folds=np.full(len(records), fold, dtype=np.int8),
        partitions=np.full(len(records), partition.encode(), dtype="S24"),
    )


def export_teacher_dataset(
    *,
    experiment_root: Path,
    foundation_root: Path,
    sampling_root: Path,
    ranking_root: Path,
    market_root: Path,
    execution_label_root: Path,
    output_root: Path,
    samples_per_date: int = DEFAULT_SAMPLES_PER_DATE,
) -> dict:
    from platform_app.modules.experiments.foundation_return_dataset import (
        _verified_upstream,
        verify_foundation_return_dataset,
    )
    from platform_app.modules.experiments.foundation_sampling_dataset import (
        verify_foundation_sampling_dataset,
    )

    experiment = load_frozen_experiment(experiment_root)
    foundation, _ = verify_foundation_return_dataset(foundation_root)
    sampling, _ = verify_foundation_sampling_dataset(sampling_root)
    ranking, ranking_database = _verified_upstream(
        ranking_root,
        "ranking-dataset.v1",
    )
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
    datasets = []
    with FoundationReturnDatasetReader(
        foundation_root,
        ranking_dataset_root=ranking_root,
        market_dataset_root=market_root,
        execution_label_dataset_root=execution_label_root,
    ) as reader:
        connection = sqlite3.connect(
            f"{ranking_database.resolve().as_uri()}?mode=ro&immutable=1",
            uri=True,
        )
        connection.row_factory = sqlite3.Row
        try:
            for fold in SCREENING_FOLDS:
                contract = folds[fold]
                for partition in SCREENING_PARTITIONS:
                    start_key, end_key = PARTITION_RANGES[partition]
                    datasets.append(
                        _partition_samples(
                            connection,
                            reader,
                            fold=fold,
                            partition=partition,
                            start=contract[start_key],
                            end=contract[end_key],
                            samples_per_date=samples_per_date,
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
            referenceClose=combined.reference_close,
            actualReturn=combined.actual_return,
            dates=combined.dates,
            executionDates=combined.execution_dates,
            terminalDates=combined.terminal_dates,
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
        "marketDatabaseSha256": foundation["marketDataset"]["databaseSha256"],
        "executionLabelDatabaseSha256": (
            foundation["executionLabelDataset"]["databaseSha256"]
        ),
        "data": data_path.name,
        "dataSha256": _file_sha256(data_path),
        "rows": len(combined.contexts),
        "samplesPerDate": samples_per_date,
        "minimumSamplesPerDate": MINIMUM_SAMPLES_PER_DATE,
        "folds": list(SCREENING_FOLDS),
        "partitions": list(SCREENING_PARTITIONS),
        "contextLength": DEFAULT_CONTEXT_LENGTH,
        "forecastHorizon": DEFAULT_FORECAST_HORIZON,
        "forecastStep": DEFAULT_FORECAST_HORIZON,
        "target": "r_net_5d",
        "contextPolicy": (
            "LAST_90_POINT_IN_TIME_ADJUSTED_CLOSE_ENDING_ON_DECISION_DATE"
        ),
        "forecastTarget": "FIFTH_FUTURE_SESSION_ADJUSTED_CLOSE",
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
            reference_close=saved["referenceClose"].copy(),
            actual_return=saved["actualReturn"].copy(),
            dates=saved["dates"].copy(),
            execution_dates=saved["executionDates"].copy(),
            terminal_dates=saved["terminalDates"].copy(),
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
        result += calibration_residual_quantiles[2]
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
    selected_point_price = select_forecast_steps(
        raw.point,
        dataset.forecast_steps,
    )
    selected_point = price_forecasts_to_fee_adjusted_returns(
        selected_point_price,
        dataset.reference_close,
        dataset.boards,
        dataset.execution_dates,
        dataset.terminal_dates,
    )
    if raw.quantiles.shape[2]:
        selected_native_price = select_forecast_steps(
            raw.quantiles,
            dataset.forecast_steps,
        )
        selected_native = price_forecasts_to_fee_adjusted_returns(
            selected_native_price,
            dataset.reference_close,
            dataset.boards,
            dataset.execution_dates,
            dataset.terminal_dates,
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
        "pointForecastProxy": (
            "FIFTH_ADJUSTED_CLOSE_OVER_DECISION_ADJUSTED_CLOSE_FEE_ADJUSTED"
        ),
        "quantilePolicy": (
            "WEIGHTED_EMPIRICAL_POINT_RESIDUALS"
            if model_name == "ttm-r2.1"
            else (
                "NATIVE_WITHIN_RANGE_LINEAR_INTERPOLATION_PLUS_"
                "WEIGHTED_MEDIAN_POINT_RESIDUAL"
            )
        ),
    }
    predictions = {
        "dates": dataset.dates[test],
        "instruments": dataset.instruments[test],
        "actualReturn": dataset.actual_return[test],
        "sampleWeight": dataset.sample_weight[test],
        "pointNetProxy": selected_point[test].astype(np.float32),
        "pWin": probability[test].astype(np.float32),
        **{
            f"q{round(level * 100):02d}": quantiles[test, index]
            for index, level in enumerate(SCREENING_QUANTILES)
        },
    }
    return metrics, predictions


def _device(model_name: str, requested: str) -> str:
    if requested != "auto":
        return requested
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if (
        model_name == "ttm-r2.1"
        and hasattr(torch.backends, "mps")
        and torch.backends.mps.is_available()
    ):
        return "mps"
    return "cpu"


def _run_ttm(
    contexts: np.ndarray,
    *,
    batch_size: int,
    device: str,
) -> TeacherRawForecast:
    import torch
    from tsfm_public.models.tinytimemixer import (
        TinyTimeMixerForPrediction,
    )

    spec = MODEL_SPECS["ttm-r2.1"]
    model = TinyTimeMixerForPrediction.from_pretrained(
        spec["modelId"],
        revision=spec["revision"],
    )
    model.to(device)
    model.eval()
    outputs = []
    started = time.monotonic()
    with torch.inference_mode():
        for start in range(0, len(contexts), batch_size):
            values = torch.from_numpy(
                contexts[start : start + batch_size, :, None],
            ).to(device)
            frequency = torch.full(
                (len(values),),
                TTM_DAILY_FREQUENCY_TOKEN,
                dtype=torch.long,
                device=device,
            )
            prediction = model(
                past_values=values,
                freq_token=frequency,
                return_loss=False,
            ).prediction_outputs
            outputs.append(prediction[:, :DEFAULT_FORECAST_HORIZON, 0].cpu())
    elapsed = time.monotonic() - started
    point = torch.cat(outputs).numpy().astype(np.float32)
    return TeacherRawForecast(
        point=point,
        quantiles=np.empty(
            (len(point), DEFAULT_FORECAST_HORIZON, 0),
            dtype=np.float32,
        ),
        quantile_levels=(),
        inference_seconds=elapsed,
    )


def _run_timesfm(
    contexts: np.ndarray,
    *,
    batch_size: int,
) -> TeacherRawForecast:
    import timesfm

    spec = MODEL_SPECS["timesfm-2.5"]
    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(
        spec["modelId"],
        revision=spec["revision"],
        torch_compile=False,
    )
    model.compile(
        timesfm.ForecastConfig(
            max_context=DEFAULT_CONTEXT_LENGTH,
            max_horizon=DEFAULT_FORECAST_HORIZON,
            normalize_inputs=True,
            per_core_batch_size=batch_size,
            use_continuous_quantile_head=True,
            force_flip_invariance=True,
            infer_is_positive=False,
            fix_quantile_crossing=True,
        )
    )
    started = time.monotonic()
    point, raw_quantiles = model.forecast(
        horizon=DEFAULT_FORECAST_HORIZON,
        inputs=[values for values in contexts],
    )
    elapsed = time.monotonic() - started
    raw_quantiles = np.asarray(raw_quantiles)
    native_levels = tuple(MODEL_SPECS["timesfm-2.5"]["nativeQuantiles"])
    if raw_quantiles.shape == (
        len(contexts),
        DEFAULT_FORECAST_HORIZON,
        len(native_levels) + 1,
    ):
        raw_quantiles = raw_quantiles[..., 1:]
    return TeacherRawForecast(
        point=np.asarray(point, dtype=np.float32),
        quantiles=np.asarray(raw_quantiles, dtype=np.float32),
        quantile_levels=native_levels,
        inference_seconds=elapsed,
    )


def _run_chronos(
    contexts: np.ndarray,
    *,
    batch_size: int,
    device: str,
) -> TeacherRawForecast:
    from chronos import Chronos2Pipeline

    spec = MODEL_SPECS["chronos-2"]
    pipeline = Chronos2Pipeline.from_pretrained(
        spec["modelId"],
        revision=spec["revision"],
        device_map=device,
    )
    started = time.monotonic()
    quantiles, median = pipeline.predict_quantiles(
        inputs=[values for values in contexts],
        prediction_length=DEFAULT_FORECAST_HORIZON,
        quantile_levels=list(DEFAULT_QUANTILES),
        batch_size=batch_size,
        context_length=DEFAULT_CONTEXT_LENGTH,
    )
    elapsed = time.monotonic() - started

    def univariate(values, dimensions: int) -> np.ndarray:
        result = []
        for value in values:
            array = value.detach().cpu().numpy()
            if array.ndim == dimensions + 1 and array.shape[0] == 1:
                array = array[0]
            result.append(array)
        return np.stack(result)

    return TeacherRawForecast(
        point=univariate(median, 1).astype(np.float32),
        quantiles=univariate(quantiles, 2).astype(np.float32),
        quantile_levels=DEFAULT_QUANTILES,
        inference_seconds=elapsed,
    )


def run_teacher_inference(
    *,
    dataset_root: Path,
    output_root: Path,
    model_name: str,
    batch_size: int = DEFAULT_BATCH_SIZE,
    device: str = "auto",
) -> dict:
    if model_name not in MODEL_SPECS or batch_size <= 0:
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_RUN_CONFIG_INVALID",
        )
    dataset, data_manifest = load_teacher_dataset(dataset_root)
    resolved_device = _device(model_name, device)
    root = output_root / model_name
    if (root / "receipt.json").is_file():
        _raw, existing = load_teacher_forecast(
            root,
            expected_dataset_sha256=data_manifest["dataSha256"],
        )
        if (
            existing.get("model") == model_name
            and existing.get("batchSize") == batch_size
            and existing.get("device") == resolved_device
        ):
            return existing
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_RESUME_CONFIG_MISMATCH",
        )
    if model_name == "ttm-r2.1":
        raw = _run_ttm(
            dataset.contexts,
            batch_size=batch_size,
            device=resolved_device,
        )
    elif model_name == "timesfm-2.5":
        raw = _run_timesfm(
            dataset.contexts,
            batch_size=batch_size,
        )
    else:
        raw = _run_chronos(
            dataset.contexts,
            batch_size=batch_size,
            device=resolved_device,
        )
    root.mkdir(parents=True, exist_ok=True)
    raw_path = root / "raw-forecast.npz"
    temporary = raw_path.with_suffix(".npz.tmp")
    with temporary.open("wb") as stream:
        np.savez_compressed(
            stream,
            point=raw.point,
            quantiles=raw.quantiles,
            quantileLevels=np.asarray(raw.quantile_levels),
            inferenceSeconds=np.asarray(raw.inference_seconds),
        )
    os.replace(temporary, raw_path)
    distributions = {}
    for name in (
        "torch",
        "numpy",
        "granite-tsfm",
        "timesfm",
        "chronos-forecasting",
        "transformers",
    ):
        try:
            distributions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            continue
    receipt = {
        "schemaVersion": "foundation-teacher-inference-receipt.v1",
        "model": model_name,
        "modelSpec": MODEL_SPECS[model_name],
        "datasetSha256": data_manifest["dataSha256"],
        "forecastUnit": "ADJUSTED_PRICE",
        "forecastTarget": data_manifest["forecastTarget"],
        "rows": len(dataset.contexts),
        "batchSize": batch_size,
        "device": resolved_device,
        "inferenceSeconds": raw.inference_seconds,
        "rawForecast": raw_path.name,
        "rawForecastSha256": _file_sha256(raw_path),
        "platform": platform.platform(),
        "python": platform.python_version(),
        "distributions": distributions,
        "paidCostCny": "0.00",
        "releaseStatus": "UNAVAILABLE",
    }
    _write_json(root / "receipt.json", receipt, immutable=True)
    return receipt


def load_teacher_forecast(
    root: Path,
    *,
    expected_dataset_sha256: str,
) -> tuple[TeacherRawForecast, dict]:
    try:
        receipt = json.loads((root / "receipt.json").read_text())
        raw_path = root / receipt["rawForecast"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_FORECAST_NOT_SEALED",
        ) from exc
    if (
        receipt.get("schemaVersion")
        != "foundation-teacher-inference-receipt.v1"
        or receipt.get("datasetSha256") != expected_dataset_sha256
        or not raw_path.is_file()
        or _file_sha256(raw_path) != receipt.get("rawForecastSha256")
    ):
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_FORECAST_INVALID",
        )
    with np.load(raw_path, allow_pickle=False) as saved:
        raw = TeacherRawForecast(
            point=saved["point"].copy(),
            quantiles=saved["quantiles"].copy(),
            quantile_levels=tuple(saved["quantileLevels"].tolist()),
            inference_seconds=float(saved["inferenceSeconds"]),
        )
    if len(raw.point) != receipt["rows"]:
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_FORECAST_COUNT_MISMATCH",
        )
    return raw, receipt


def evaluate_teacher_model(
    *,
    dataset_root: Path,
    inference_root: Path,
    output_root: Path,
    model_name: str,
) -> dict:
    dataset, data_manifest = load_teacher_dataset(dataset_root)
    raw, receipt = load_teacher_forecast(
        inference_root / model_name,
        expected_dataset_sha256=data_manifest["dataSha256"],
    )
    if receipt["model"] != model_name:
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_MODEL_MISMATCH",
        )
    root = output_root / model_name
    root.mkdir(parents=True, exist_ok=True)
    folds = []
    files = {}
    for fold in SCREENING_FOLDS:
        metrics, predictions = evaluate_teacher_test(
            dataset,
            raw,
            model_name=model_name,
            fold=fold,
        )
        prediction_path = root / f"fold-{fold}-test.npz"
        temporary = prediction_path.with_suffix(".npz.tmp")
        with temporary.open("wb") as stream:
            np.savez_compressed(stream, **predictions)
        os.replace(temporary, prediction_path)
        files[prediction_path.name] = _file_sha256(prediction_path)
        folds.append(metrics)
    evaluation_path = root / "evaluation.json"
    evaluation = {
        "schemaVersion": "foundation-teacher-evaluation.v1",
        "model": model_name,
        "datasetSha256": data_manifest["dataSha256"],
        "inferenceReceiptSha256": _file_sha256(
            inference_root / model_name / "receipt.json",
        ),
        "folds": folds,
        "releaseStatus": "UNAVAILABLE",
    }
    _write_json(evaluation_path, evaluation, immutable=True)
    files[evaluation_path.name] = _file_sha256(evaluation_path)
    result = {
        "schemaVersion": "foundation-teacher-evaluation-receipt.v1",
        "model": model_name,
        "files": files,
        "paidCostCny": "0.00",
        "releaseStatus": "UNAVAILABLE",
    }
    _write_json(root / "receipt.json", result, immutable=True)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export")
    export.add_argument("--experiment-root", type=Path, required=True)
    export.add_argument("--foundation-root", type=Path, required=True)
    export.add_argument("--sampling-root", type=Path, required=True)
    export.add_argument("--ranking-root", type=Path, required=True)
    export.add_argument("--market-root", type=Path, required=True)
    export.add_argument("--execution-label-root", type=Path, required=True)
    export.add_argument("--output", type=Path, required=True)
    export.add_argument(
        "--samples-per-date",
        type=int,
        default=DEFAULT_SAMPLES_PER_DATE,
    )
    run = commands.add_parser("run")
    run.add_argument("--dataset-root", type=Path, required=True)
    run.add_argument("--output", type=Path, required=True)
    run.add_argument("--model", choices=tuple(MODEL_SPECS), required=True)
    run.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    run.add_argument(
        "--device",
        choices=("auto", "cuda", "mps", "cpu"),
        default="auto",
    )
    evaluate = commands.add_parser("evaluate")
    evaluate.add_argument("--dataset-root", type=Path, required=True)
    evaluate.add_argument("--inference-root", type=Path, required=True)
    evaluate.add_argument("--output", type=Path, required=True)
    evaluate.add_argument("--model", choices=tuple(MODEL_SPECS), required=True)
    args = parser.parse_args()
    if args.command == "export":
        result = export_teacher_dataset(
            experiment_root=args.experiment_root,
            foundation_root=args.foundation_root,
            sampling_root=args.sampling_root,
            ranking_root=args.ranking_root,
            market_root=args.market_root,
            execution_label_root=args.execution_label_root,
            output_root=args.output,
            samples_per_date=args.samples_per_date,
        )
    elif args.command == "run":
        result = run_teacher_inference(
            dataset_root=args.dataset_root,
            output_root=args.output,
            model_name=args.model,
            batch_size=args.batch_size,
            device=args.device,
        )
    else:
        result = evaluate_teacher_model(
            dataset_root=args.dataset_root,
            inference_root=args.inference_root,
            output_root=args.output,
            model_name=args.model,
        )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
