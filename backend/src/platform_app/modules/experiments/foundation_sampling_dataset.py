"""Deterministic stratified training index for foundation return models."""

import argparse
import hashlib
import json
import os
import sqlite3
from collections import defaultdict
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from platform_app.modules.experiments.episode_dataset import (
    canonical_json,
    canonical_sha256,
)
from platform_app.modules.experiments.foundation_market_cap_dataset import (
    FoundationMarketCapDatasetError,
    verify_foundation_market_cap_dataset,
)
from platform_app.modules.experiments.foundation_return_dataset import (
    FoundationReturnDatasetError,
    build_foundation_walk_forward_splits,
    reference_full_fill_net_return,
    verify_foundation_return_dataset,
)

SCHEMA_VERSION = "foundation-training-sampling.v1"
POLICY_VERSION = "foundation-deterministic-stratified-sampling.v1"
DEFAULT_MAX_WINDOWS_PER_FOLD = 1_500_000
DEFAULT_SAMPLING_SEED = 20260917
QUANTILE_BUCKETS = 5
FOLD_CONTRACT_KEYS = (
    "fold",
    "trainStart",
    "trainEnd",
    "probabilityCalibrationStart",
    "probabilityCalibrationEnd",
    "conformalCalibrationStart",
    "conformalCalibrationEnd",
    "testStart",
    "testEnd",
    "trainSessions",
    "probabilityCalibrationSessions",
    "conformalCalibrationSessions",
    "testSessions",
    "purgeSessions",
    "embargoSessions",
)
POLICY = {
    "policyVersion": POLICY_VERSION,
    "dateAllocation": "EQUAL_WITH_DETERMINISTIC_REMAINDER",
    "strata": [
        "board",
        "daily_total_market_cap_quintile",
        "daily_median_amount_20_quintile",
        "reference_fee_adjusted_return_direction",
    ],
    "withinStratumSelection": "LOWEST_SHA256_SCORE",
    "probability": "SELECTED_IN_STRATUM_DIVIDED_BY_POPULATION_IN_STRATUM",
    "weight": "INVERSE_SELECTION_PROBABILITY",
    "marketCapUsage": "TRAINING_SAMPLING_ONLY_NOT_MODEL_FEATURE",
    "testPolicy": "FULL_UNIVERSE_NOT_SAMPLED",
    "calibrationPolicy": "FULL_UNIVERSE_NOT_SAMPLED",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS sampling_dataset_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    dataset_id TEXT NOT NULL UNIQUE,
    schema_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    foundation_dataset_id TEXT NOT NULL,
    foundation_database_sha256 TEXT NOT NULL,
    market_cap_dataset_id TEXT NOT NULL,
    market_cap_database_sha256 TEXT NOT NULL,
    ranking_database_sha256 TEXT NOT NULL,
    sampling_seed INTEGER NOT NULL,
    max_windows_per_fold INTEGER NOT NULL CHECK (max_windows_per_fold > 0),
    policy_sha256 TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    folds_sha256 TEXT NOT NULL,
    folds_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sampling_partitions (
    fold INTEGER NOT NULL CHECK (fold BETWEEN 1 AND 5),
    decision_date TEXT NOT NULL,
    population_count INTEGER NOT NULL CHECK (population_count > 0),
    selected_count INTEGER NOT NULL
        CHECK (selected_count > 0 AND selected_count <= population_count),
    payload_sha256 TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (fold, decision_date)
) STRICT;
CREATE TABLE IF NOT EXISTS sampling_strata (
    fold INTEGER NOT NULL,
    decision_date TEXT NOT NULL,
    stratum_id TEXT NOT NULL,
    board TEXT NOT NULL,
    market_cap_bucket INTEGER NOT NULL CHECK (market_cap_bucket BETWEEN 1 AND 5),
    liquidity_bucket INTEGER NOT NULL CHECK (liquidity_bucket BETWEEN 1 AND 5),
    outcome_bucket TEXT NOT NULL CHECK (outcome_bucket IN ('LOSS', 'NON_LOSS')),
    population_count INTEGER NOT NULL CHECK (population_count > 0),
    selected_count INTEGER NOT NULL
        CHECK (selected_count > 0 AND selected_count <= population_count),
    sampling_probability TEXT NOT NULL,
    inverse_probability_weight TEXT NOT NULL,
    PRIMARY KEY (fold, decision_date, stratum_id),
    FOREIGN KEY (fold, decision_date)
        REFERENCES sampling_partitions(fold, decision_date)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS training_samples (
    fold INTEGER NOT NULL,
    decision_date TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    stratum_id TEXT NOT NULL,
    deterministic_score TEXT NOT NULL,
    PRIMARY KEY (fold, decision_date, instrument_id),
    FOREIGN KEY (fold, decision_date, stratum_id)
        REFERENCES sampling_strata(fold, decision_date, stratum_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS training_samples_instrument_idx
ON training_samples(fold, instrument_id, decision_date);
"""


class FoundationSamplingDatasetError(ValueError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_foundation_sampling_dataset(root: Path) -> tuple[dict, Path]:
    resolved = root.expanduser().resolve()
    manifest_path = resolved / "split-manifest.json"
    if not manifest_path.is_file():
        raise FoundationSamplingDatasetError(
            "FOUNDATION_SAMPLING_NOT_SEALED",
        )
    try:
        manifest = json.loads(manifest_path.read_text())
        database = resolved / manifest["database"]
        expected_hash = manifest["databaseSha256"]
    except (KeyError, json.JSONDecodeError, TypeError) as exc:
        raise FoundationSamplingDatasetError(
            "FOUNDATION_SAMPLING_MANIFEST_INVALID",
        ) from exc
    if (
        manifest.get("schemaVersion") != SCHEMA_VERSION
        or not database.is_file()
        or _file_sha256(database) != expected_hash
    ):
        raise FoundationSamplingDatasetError(
            "FOUNDATION_SAMPLING_INVALID",
        )
    connection = sqlite3.connect(
        f"{database.resolve().as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    try:
        metadata = dict(
            connection.execute(
                "SELECT * FROM sampling_dataset_metadata",
            ).fetchone()
        )
        fold_totals = {
            row["fold"]: dict(row)
            for row in connection.execute(
                "SELECT fold, COUNT(*) AS train_dates, "
                "SUM(population_count) AS train_population, "
                "SUM(selected_count) AS train_selected "
                "FROM sampling_partitions GROUP BY fold ORDER BY fold",
            )
        }
    except (sqlite3.DatabaseError, TypeError) as exc:
        raise FoundationSamplingDatasetError(
            "FOUNDATION_SAMPLING_INVALID",
        ) from exc
    finally:
        connection.close()
    try:
        base_folds = [
            {key: fold[key] for key in FOLD_CONTRACT_KEYS}
            for fold in manifest["folds"]
        ]
    except (KeyError, TypeError) as exc:
        raise FoundationSamplingDatasetError(
            "FOUNDATION_SAMPLING_MANIFEST_INVALID",
        ) from exc
    expected_values = {
        "datasetId": metadata["dataset_id"],
        "schemaVersion": metadata["schema_version"],
        "databaseSha256": expected_hash,
        "foundationDatasetId": metadata["foundation_dataset_id"],
        "foundationDatabaseSha256": metadata["foundation_database_sha256"],
        "marketCapDatasetId": metadata["market_cap_dataset_id"],
        "marketCapDatabaseSha256": metadata["market_cap_database_sha256"],
        "rankingDatabaseSha256": metadata["ranking_database_sha256"],
        "samplingSeed": metadata["sampling_seed"],
        "maximumWindowsPerFold": metadata["max_windows_per_fold"],
        "policySha256": metadata["policy_sha256"],
        "foldsSha256": metadata["folds_sha256"],
    }
    fold_manifest_mismatch = (
        hashlib.sha256(canonical_json(base_folds).encode()).hexdigest()
        != metadata["folds_sha256"]
        or any(
            fold_totals.get(fold["fold"], {}).get("train_dates")
            != fold["trainSessions"]
            or fold_totals.get(fold["fold"], {}).get("train_population")
            != fold["trainPopulation"]
            or fold_totals.get(fold["fold"], {}).get("train_selected")
            != fold["trainSelected"]
            for fold in manifest.get("folds", [])
        )
    )
    if (
        any(
            manifest.get(key) != value
            for key, value in expected_values.items()
        )
        or fold_manifest_mismatch
    ):
        raise FoundationSamplingDatasetError(
            "FOUNDATION_SAMPLING_MANIFEST_MISMATCH",
        )
    return manifest, database


def _text(value: Decimal) -> str:
    rendered = format(value.normalize(), "f")
    return "0" if rendered in {"", "-0"} else rendered


def _largest_remainder_allocation(
    capacities: dict[str, int],
    target: int,
    *,
    guarantee_one: bool,
) -> dict[str, int]:
    if target <= 0 or target > sum(capacities.values()):
        raise FoundationSamplingDatasetError(
            "FOUNDATION_SAMPLING_ALLOCATION_INVALID",
        )
    keys = sorted(capacities)
    allocation = {key: 0 for key in keys}
    remaining_capacities = dict(capacities)
    if guarantee_one and target >= len(keys):
        for key in keys:
            allocation[key] = 1
            remaining_capacities[key] -= 1
    remaining_target = target - sum(allocation.values())
    total_capacity = sum(remaining_capacities.values())
    if remaining_target == 0:
        return allocation
    if total_capacity <= 0:
        raise FoundationSamplingDatasetError(
            "FOUNDATION_SAMPLING_ALLOCATION_INVALID",
        )
    ideals = {
        key: Decimal(remaining_target)
        * remaining_capacities[key]
        / Decimal(total_capacity)
        for key in keys
    }
    for key in keys:
        amount = min(remaining_capacities[key], int(ideals[key]))
        allocation[key] += amount
    remaining = target - sum(allocation.values())
    ranked = sorted(
        keys,
        key=lambda key: (
            ideals[key] - int(ideals[key]),
            remaining_capacities[key],
            key,
        ),
        reverse=True,
    )
    while remaining > 0:
        progressed = False
        for key in ranked:
            if allocation[key] >= capacities[key]:
                continue
            allocation[key] += 1
            remaining -= 1
            progressed = True
            if remaining == 0:
                break
        if not progressed:
            raise FoundationSamplingDatasetError(
                "FOUNDATION_SAMPLING_ALLOCATION_INVALID",
            )
    return allocation


def allocate_daily_quotas(
    date_counts: dict[str, int],
    maximum_windows: int,
) -> dict[str, int]:
    if (
        not date_counts
        or maximum_windows <= 0
        or any(count <= 0 for count in date_counts.values())
        or maximum_windows < len(date_counts)
    ):
        raise FoundationSamplingDatasetError(
            "FOUNDATION_DAILY_QUOTA_INPUT_INVALID",
        )
    target = min(maximum_windows, sum(date_counts.values()))
    return _largest_remainder_allocation(
        date_counts,
        target,
        guarantee_one=True,
    )


def _quantile_buckets(rows: list[dict], key: str) -> dict[str, int]:
    ordered = sorted(
        rows,
        key=lambda row: (Decimal(row[key]), row["instrument_id"]),
    )
    total = len(ordered)
    return {
        row["instrument_id"]: min(
            QUANTILE_BUCKETS,
            index * QUANTILE_BUCKETS // total + 1,
        )
        for index, row in enumerate(ordered)
    }


def _stratify_rows(rows: list[dict]) -> dict[str, list[dict]]:
    if not rows:
        raise FoundationSamplingDatasetError(
            "FOUNDATION_SAMPLING_DATE_EMPTY",
        )
    market_cap_buckets = _quantile_buckets(rows, "total_market_cap_cny")
    liquidity_buckets = _quantile_buckets(rows, "median_amount_20_cny")
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        net_return = reference_full_fill_net_return(
            gross_return=row["forward_return_next_open_5"],
            board=row["board"],
            execution_date=row["execution_date"],
            terminal_date=row["terminal_date"],
        )
        market_cap_bucket = market_cap_buckets[row["instrument_id"]]
        liquidity_bucket = liquidity_buckets[row["instrument_id"]]
        outcome_bucket = "NON_LOSS" if net_return >= 0 else "LOSS"
        stratum_id = (
            f"{row['board']}:M{market_cap_bucket}:"
            f"L{liquidity_bucket}:{outcome_bucket}"
        )
        grouped[stratum_id].append(
            {
                **row,
                "market_cap_bucket": market_cap_bucket,
                "liquidity_bucket": liquidity_bucket,
                "outcome_bucket": outcome_bucket,
            }
        )
    return dict(grouped)


def select_stratified_training_rows(
    rows: list[dict],
    *,
    fold: int,
    decision_date: str,
    quota: int,
    sampling_seed: int = DEFAULT_SAMPLING_SEED,
) -> tuple[list[dict], list[dict]]:
    if quota <= 0 or quota > len(rows):
        raise FoundationSamplingDatasetError(
            "FOUNDATION_SAMPLING_DATE_QUOTA_INVALID",
        )
    grouped = _stratify_rows(rows)
    allocation = _largest_remainder_allocation(
        {key: len(values) for key, values in grouped.items()},
        quota,
        guarantee_one=True,
    )
    selected = []
    strata = []
    for stratum_id in sorted(grouped):
        population = grouped[stratum_id]
        selected_count = allocation[stratum_id]
        if selected_count == 0:
            continue
        scored = sorted(
            (
                hashlib.sha256(
                    (
                        f"{POLICY_VERSION}:{sampling_seed}:{fold}:"
                        f"{decision_date}:{row['instrument_id']}"
                    ).encode()
                ).hexdigest(),
                row["instrument_id"],
                row,
            )
            for row in population
        )
        probability = Decimal(selected_count) / Decimal(len(population))
        weight = Decimal(len(population)) / Decimal(selected_count)
        sample = [
            {
                "fold": fold,
                "decisionDate": decision_date,
                "instrumentId": row["instrument_id"],
                "stratumId": stratum_id,
                "deterministicScore": score,
            }
            for score, _instrument_id, row in scored[:selected_count]
        ]
        selected.extend(sample)
        first = population[0]
        strata.append(
            {
                "fold": fold,
                "decisionDate": decision_date,
                "stratumId": stratum_id,
                "board": first["board"],
                "marketCapBucket": first["market_cap_bucket"],
                "liquidityBucket": first["liquidity_bucket"],
                "outcomeBucket": first["outcome_bucket"],
                "populationCount": len(population),
                "selectedCount": selected_count,
                "samplingProbability": _text(probability),
                "inverseProbabilityWeight": _text(weight),
            }
        )
    selected.sort(key=lambda row: row["instrumentId"])
    return selected, strata


class FoundationSamplingDataset:
    def __init__(
        self,
        root: Path,
        *,
        dataset_id: str,
        foundation_dataset_root: Path,
        ranking_dataset_root: Path,
        market_cap_dataset_root: Path,
        maximum_windows_per_fold: int = DEFAULT_MAX_WINDOWS_PER_FOLD,
        sampling_seed: int = DEFAULT_SAMPLING_SEED,
        folds: list[dict] | None = None,
    ):
        self.root = root.expanduser().resolve()
        self.database_path = self.root / "sampling.sqlite3"
        self.manifest_path = self.root / "split-manifest.json"
        if self.manifest_path.exists():
            raise FoundationSamplingDatasetError(
                "FOUNDATION_SAMPLING_ALREADY_SEALED",
            )
        try:
            foundation, foundation_database = verify_foundation_return_dataset(
                foundation_dataset_root,
            )
            market_cap, self.market_cap_database_path = (
                verify_foundation_market_cap_dataset(
                    market_cap_dataset_root,
                )
            )
        except (
            FoundationReturnDatasetError,
            FoundationMarketCapDatasetError,
        ) as exc:
            raise FoundationSamplingDatasetError(
                "FOUNDATION_SAMPLING_UPSTREAM_INVALID",
            ) from exc
        ranking = foundation["rankingDataset"]
        ranking_manifest_path = (
            ranking_dataset_root.expanduser().resolve() / "manifest.json"
        )
        try:
            ranking_manifest = json.loads(ranking_manifest_path.read_text())
            self.ranking_database_path = (
                ranking_dataset_root.expanduser().resolve()
                / ranking_manifest["database"]
            )
        except (OSError, KeyError, json.JSONDecodeError, TypeError) as exc:
            raise FoundationSamplingDatasetError(
                "FOUNDATION_SAMPLING_RANKING_INVALID",
            ) from exc
        if (
            ranking_manifest.get("databaseSha256") != ranking["databaseSha256"]
            or _file_sha256(self.ranking_database_path) != ranking["databaseSha256"]
            or market_cap.get("foundationDatabaseSha256")
            != foundation["databaseSha256"]
            or market_cap.get("rankingDatabaseSha256")
            != ranking["databaseSha256"]
        ):
            raise FoundationSamplingDatasetError(
                "FOUNDATION_SAMPLING_LINEAGE_MISMATCH",
            )
        if maximum_windows_per_fold <= 0:
            raise FoundationSamplingDatasetError(
                "FOUNDATION_SAMPLING_LIMIT_INVALID",
            )
        self.ranking = self._open_readonly(self.ranking_database_path)
        dates = [
            row["decision_date"]
            for row in self.ranking.execute(
                "SELECT DISTINCT decision_date FROM ranking_samples "
                "ORDER BY decision_date",
            )
        ]
        self.folds = folds or build_foundation_walk_forward_splits(dates)
        if [fold["fold"] for fold in self.folds] != [1, 2, 3, 4, 5]:
            raise FoundationSamplingDatasetError(
                "FOUNDATION_SAMPLING_FOLDS_INVALID",
            )
        self.maximum_windows_per_fold = maximum_windows_per_fold
        self.sampling_seed = sampling_seed
        self.date_counts = {
            row["decision_date"]: row["sample_count"]
            for row in self.ranking.execute(
                "SELECT decision_date, COUNT(*) AS sample_count "
                "FROM ranking_samples GROUP BY decision_date "
                "ORDER BY decision_date",
            )
        }
        self.quotas = {
            fold["fold"]: allocate_daily_quotas(
                {
                    date: count
                    for date, count in self.date_counts.items()
                    if date <= fold["trainEnd"]
                },
                maximum_windows_per_fold,
            )
            for fold in self.folds
        }
        policy = {
            **POLICY,
            "samplingSeed": sampling_seed,
            "maximumWindowsPerFold": maximum_windows_per_fold,
        }
        policy_json = canonical_json(policy)
        folds_json = canonical_json(self.folds)
        identity = (
            dataset_id,
            SCHEMA_VERSION,
            foundation["datasetId"],
            _file_sha256(foundation_database),
            market_cap["datasetId"],
            market_cap["databaseSha256"],
            ranking["databaseSha256"],
            sampling_seed,
            maximum_windows_per_fold,
            hashlib.sha256(policy_json.encode()).hexdigest(),
            policy_json,
            hashlib.sha256(folds_json.encode()).hexdigest(),
            folds_json,
        )
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.database_path, autocommit=True)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.execute("PRAGMA synchronous = NORMAL")
        self.db.autocommit = False
        self.db.executescript(SCHEMA)
        existing = self.db.execute(
            "SELECT dataset_id, schema_version, foundation_dataset_id, "
            "foundation_database_sha256, market_cap_dataset_id, "
            "market_cap_database_sha256, ranking_database_sha256, sampling_seed, "
            "max_windows_per_fold, policy_sha256, policy_json, folds_sha256, "
            "folds_json FROM sampling_dataset_metadata",
        ).fetchone()
        if existing and tuple(existing) != identity:
            self.close()
            raise FoundationSamplingDatasetError(
                "FOUNDATION_SAMPLING_IDENTITY_MISMATCH",
            )
        if not existing:
            self.db.execute(
                "INSERT INTO sampling_dataset_metadata VALUES "
                "(1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (dataset_id, SCHEMA_VERSION, _now(), *identity[2:]),
            )
            self.db.commit()
        cap_uri = (
            f"{self.market_cap_database_path.resolve().as_uri()}"
            "?mode=ro&immutable=1"
        )
        self.ranking.execute("ATTACH DATABASE ? AS cap", (cap_uri,))

    @staticmethod
    def _open_readonly(path: Path) -> sqlite3.Connection:
        connection = sqlite3.connect(
            f"{path.resolve().as_uri()}?mode=ro&immutable=1",
            uri=True,
        )
        connection.row_factory = sqlite3.Row
        return connection

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()

    def close(self) -> None:
        self.ranking.close()
        self.db.close()

    def _date_rows(self, decision_date: str) -> list[dict]:
        rows = [
            dict(row)
            for row in self.ranking.execute(
                "SELECT r.instrument_id, r.board, r.execution_date, "
                "r.terminal_date, r.median_amount_20_cny, "
                "r.forward_return_next_open_5, c.total_market_cap_cny "
                "FROM ranking_samples r JOIN cap.market_cap_rows c "
                "ON c.instrument_id = r.instrument_id "
                "AND c.decision_date = r.decision_date "
                "WHERE r.decision_date = ? ORDER BY r.instrument_id",
                (decision_date,),
            )
        ]
        if len(rows) != self.date_counts[decision_date]:
            raise FoundationSamplingDatasetError(
                "FOUNDATION_SAMPLING_DATE_COVERAGE_MISMATCH",
            )
        return rows

    def build_partition(self, fold: int, decision_date: str) -> dict:
        quota = self.quotas.get(fold, {}).get(decision_date)
        if quota is None:
            raise FoundationSamplingDatasetError(
                "FOUNDATION_SAMPLING_PARTITION_NOT_TRAINING",
            )
        existing = self.db.execute(
            "SELECT population_count, selected_count FROM sampling_partitions "
            "WHERE fold = ? AND decision_date = ?",
            (fold, decision_date),
        ).fetchone()
        if existing:
            return {
                "fold": fold,
                "decisionDate": decision_date,
                "status": "SKIPPED",
                "populationCount": existing["population_count"],
                "selectedCount": existing["selected_count"],
            }
        rows = self._date_rows(decision_date)
        selected, strata = select_stratified_training_rows(
            rows,
            fold=fold,
            decision_date=decision_date,
            quota=quota,
            sampling_seed=self.sampling_seed,
        )
        payload_hash = canonical_sha256(
            {
                "fold": fold,
                "decisionDate": decision_date,
                "populationCount": len(rows),
                "selected": selected,
                "strata": strata,
            }
        )
        try:
            self.db.execute(
                "INSERT INTO sampling_partitions VALUES (?, ?, ?, ?, ?, ?)",
                (
                    fold,
                    decision_date,
                    len(rows),
                    len(selected),
                    payload_hash,
                    _now(),
                ),
            )
            self.db.executemany(
                "INSERT INTO sampling_strata VALUES "
                f"({','.join('?' for _ in range(11))})",
                [
                    (
                        row["fold"],
                        row["decisionDate"],
                        row["stratumId"],
                        row["board"],
                        row["marketCapBucket"],
                        row["liquidityBucket"],
                        row["outcomeBucket"],
                        row["populationCount"],
                        row["selectedCount"],
                        row["samplingProbability"],
                        row["inverseProbabilityWeight"],
                    )
                    for row in strata
                ],
            )
            self.db.executemany(
                "INSERT INTO training_samples VALUES (?, ?, ?, ?, ?)",
                [
                    (
                        row["fold"],
                        row["decisionDate"],
                        row["instrumentId"],
                        row["stratumId"],
                        row["deterministicScore"],
                    )
                    for row in selected
                ],
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return {
            "fold": fold,
            "decisionDate": decision_date,
            "status": "COMPLETED",
            "populationCount": len(rows),
            "selectedCount": len(selected),
            "strata": len(strata),
            "payloadSha256": payload_hash,
        }

    def build(self):
        completed = {
            (row["fold"], row["decision_date"])
            for row in self.db.execute(
                "SELECT fold, decision_date FROM sampling_partitions",
            )
        }
        for fold in self.folds:
            number = fold["fold"]
            for decision_date in self.quotas[number]:
                if (number, decision_date) in completed:
                    continue
                yield self.build_partition(number, decision_date)

    def seal(self) -> dict:
        expected_partitions = sum(len(values) for values in self.quotas.values())
        actual_partitions = self.db.execute(
            "SELECT COUNT(*) FROM sampling_partitions",
        ).fetchone()[0]
        if actual_partitions != expected_partitions:
            raise FoundationSamplingDatasetError(
                "FOUNDATION_SAMPLING_PARTITIONS_INCOMPLETE",
            )
        fold_rows = {
            row["fold"]: dict(row)
            for row in self.db.execute(
                "SELECT fold, COUNT(*) AS train_dates, "
                "SUM(population_count) AS train_population, "
                "SUM(selected_count) AS train_selected "
                "FROM sampling_partitions GROUP BY fold ORDER BY fold",
            )
        }
        fold_manifests = []
        for fold in self.folds:
            number = fold["fold"]
            totals = fold_rows[number]
            if totals["train_selected"] > self.maximum_windows_per_fold:
                raise FoundationSamplingDatasetError(
                    "FOUNDATION_SAMPLING_LIMIT_EXCEEDED",
                )
            full_counts = {}
            for name, start_key, end_key in (
                (
                    "probabilityCalibration",
                    "probabilityCalibrationStart",
                    "probabilityCalibrationEnd",
                ),
                (
                    "conformalCalibration",
                    "conformalCalibrationStart",
                    "conformalCalibrationEnd",
                ),
                ("test", "testStart", "testEnd"),
            ):
                full_counts[name] = self.ranking.execute(
                    "SELECT COUNT(*) FROM ranking_samples "
                    "WHERE decision_date BETWEEN ? AND ?",
                    (fold[start_key], fold[end_key]),
                ).fetchone()[0]
            fold_manifests.append(
                {
                    **fold,
                    "trainPopulation": totals["train_population"],
                    "trainSelected": totals["train_selected"],
                    "trainingSelection": "DETERMINISTIC_STRATIFIED_SAMPLE",
                    "probabilityCalibrationRows": full_counts[
                        "probabilityCalibration"
                    ],
                    "conformalCalibrationRows": full_counts[
                        "conformalCalibration"
                    ],
                    "testRows": full_counts["test"],
                    "calibrationSelection": "FULL_UNIVERSE",
                    "testSelection": "FULL_UNIVERSE",
                }
            )
        metadata = dict(
            self.db.execute("SELECT * FROM sampling_dataset_metadata").fetchone()
        )
        self.db.commit()
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        if self.db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise FoundationSamplingDatasetError(
                "FOUNDATION_SAMPLING_INTEGRITY_FAILED",
            )
        database_hash = _file_sha256(self.database_path)
        manifest = {
            "datasetId": metadata["dataset_id"],
            "schemaVersion": metadata["schema_version"],
            "createdAt": metadata["created_at"],
            "sealedAt": _now(),
            "database": self.database_path.name,
            "databaseSha256": database_hash,
            "foundationDatasetId": metadata["foundation_dataset_id"],
            "foundationDatabaseSha256": metadata[
                "foundation_database_sha256"
            ],
            "marketCapDatasetId": metadata["market_cap_dataset_id"],
            "marketCapDatabaseSha256": metadata[
                "market_cap_database_sha256"
            ],
            "rankingDatabaseSha256": metadata["ranking_database_sha256"],
            "samplingSeed": metadata["sampling_seed"],
            "maximumWindowsPerFold": metadata["max_windows_per_fold"],
            "policySha256": metadata["policy_sha256"],
            "foldsSha256": metadata["folds_sha256"],
            "folds": fold_manifests,
            "fullUniverseEvaluation": True,
        }
        temporary = self.manifest_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )
        os.replace(temporary, self.manifest_path)
        return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--foundation-root", type=Path, required=True)
    parser.add_argument("--ranking-root", type=Path, required=True)
    parser.add_argument("--market-cap-root", type=Path, required=True)
    parser.add_argument(
        "--maximum-windows-per-fold",
        type=int,
        default=DEFAULT_MAX_WINDOWS_PER_FOLD,
    )
    parser.add_argument(
        "--sampling-seed",
        type=int,
        default=DEFAULT_SAMPLING_SEED,
    )
    args = parser.parse_args()
    with FoundationSamplingDataset(
        args.root,
        dataset_id=args.dataset_id,
        foundation_dataset_root=args.foundation_root,
        ranking_dataset_root=args.ranking_root,
        market_cap_dataset_root=args.market_cap_root,
        maximum_windows_per_fold=args.maximum_windows_per_fold,
        sampling_seed=args.sampling_seed,
    ) as dataset:
        for result in dataset.build():
            print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)
        print(
            json.dumps(dataset.seal(), ensure_ascii=False, sort_keys=True),
            flush=True,
        )


if __name__ == "__main__":
    main()
