"""Freeze and evaluate zero-shot time-series foundation-model teachers."""

import argparse
import hashlib
import json
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import numpy as np

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

SCHEMA_VERSION = "foundation-teacher-screening.v1"
DATASET_SCHEMA_VERSION = "foundation-teacher-screening-dataset.v1"
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
                    self.folds,
                    self.partitions,
                )
            )
            or not np.all(np.isfinite(self.contexts))
            or not np.all(np.isfinite(self.actual_return))
            or np.any(self.sample_weight <= 0)
        ):
            raise FoundationTeacherError(
                "FOUNDATION_TEACHER_DATASET_INVALID",
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
        f"foundation-teacher-v1:{fold}:{partition}:{date}:{instrument}".encode(),
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
) -> np.ndarray | None:
    rows = ranking.execute(
        "SELECT board, execution_date, terminal_date, "
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
    return values.astype(np.float32)


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
            "SELECT instrument_id, board, execution_date, terminal_date, "
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
            context = _mature_return_context(
                ranking,
                instrument_id=row["instrument_id"],
                decision_date=date,
            )
            if context is None:
                continue
            target = fee_adjusted_returns(
                np.asarray([float(row["forward_return_next_open_5"])]),
                np.asarray([row["board"]]),
                np.asarray([row["execution_date"]]),
                np.asarray([row["terminal_date"]]),
            )[0]
            selected.append((row, context, target))
            if len(selected) == quotas[date]:
                break
        if len(selected) != quotas[date]:
            raise FoundationTeacherError(
                "FOUNDATION_TEACHER_CONTEXT_SUPPORT_INSUFFICIENT",
            )
        weight = 1.0 / len(selected)
        records.extend(
            (row, context, target, weight)
            for row, context, target in selected
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
            folds=saved["folds"].copy(),
            partitions=saved["partitions"].copy(),
        )
    if len(dataset.contexts) != manifest["rows"]:
        raise FoundationTeacherError(
            "FOUNDATION_TEACHER_DATASET_COUNT_MISMATCH",
        )
    return dataset, manifest


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
