"""Immutable lineage and resumable partitions for training episodes."""

import hashlib
import json
import os
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path


class EpisodeDatasetError(ValueError):
    pass


SCHEMA_VERSION = "episode-dataset.v1"
REQUIRED_POLICY_KEYS = {
    "candidatePolicy",
    "executionPolicy",
    "featureSchemaVersion",
    "horizon",
    "labelPolicy",
    "policyVersion",
    "releasePolicy",
}
BOARDS = {"MAIN", "CHINEXT", "STAR", "BEIJING"}

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS episode_dataset_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    dataset_id TEXT NOT NULL UNIQUE,
    schema_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    market_dataset_id TEXT NOT NULL,
    market_schema_version TEXT NOT NULL,
    market_database_sha256 TEXT NOT NULL,
    policy_sha256 TEXT NOT NULL,
    policy_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS candidate_partitions (
    decision_date TEXT PRIMARY KEY,
    execution_date TEXT NOT NULL,
    universe_count INTEGER NOT NULL CHECK (universe_count >= 0),
    candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
    universe_sha256 TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    completed_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS candidate_partition_rejections (
    decision_date TEXT NOT NULL REFERENCES candidate_partitions(decision_date),
    board TEXT NOT NULL,
    reason TEXT NOT NULL,
    instrument_count INTEGER NOT NULL CHECK (instrument_count > 0),
    PRIMARY KEY (decision_date, board, reason)
) STRICT;
CREATE TABLE IF NOT EXISTS candidate_episodes (
    episode_id TEXT PRIMARY KEY,
    decision_date TEXT NOT NULL REFERENCES candidate_partitions(decision_date),
    execution_date TEXT NOT NULL,
    instrument_id TEXT NOT NULL,
    board TEXT NOT NULL CHECK (board IN ('MAIN', 'CHINEXT', 'STAR', 'BEIJING')),
    rank_within_board INTEGER NOT NULL CHECK (rank_within_board > 0),
    sample_bucket TEXT NOT NULL,
    feature_available_at TEXT NOT NULL,
    feature_schema_version TEXT NOT NULL,
    features_json TEXT NOT NULL,
    selection_score TEXT NOT NULL,
    source_row_sha256 TEXT NOT NULL,
    UNIQUE (decision_date, instrument_id)
) STRICT;
"""


def canonical_json(value: dict | list) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonical_sha256(value: dict | list) -> str:
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_market_dataset(root: Path) -> dict:
    root = root.resolve()
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise EpisodeDatasetError("MARKET_DATASET_NOT_SEALED")
    try:
        manifest = json.loads(manifest_path.read_text())
        database_path = root / manifest["database"]
        expected_hash = manifest["databaseSha256"]
        dataset_id = manifest["datasetId"]
        schema_version = manifest["schemaVersion"]
    except (KeyError, json.JSONDecodeError, TypeError) as exc:
        raise EpisodeDatasetError("MARKET_MANIFEST_INVALID") from exc
    if (
        not database_path.is_file()
        or not re.fullmatch(r"[0-9a-f]{64}", expected_hash)
        or _file_sha256(database_path) != expected_hash
    ):
        raise EpisodeDatasetError("MARKET_DATABASE_HASH_MISMATCH")
    return {
        "datasetId": dataset_id,
        "schemaVersion": schema_version,
        "database": database_path,
        "databaseSha256": expected_hash,
    }


class EpisodeDataset:
    def __init__(
        self,
        root: Path,
        *,
        dataset_id: str,
        market_dataset_root: Path,
        policy: dict,
    ):
        missing = REQUIRED_POLICY_KEYS - policy.keys()
        if missing:
            raise EpisodeDatasetError(
                f"POLICY_MISSING_KEYS:{','.join(sorted(missing))}"
            )
        self.root = root.resolve()
        self.db_path = self.root / "episodes.sqlite3"
        self.manifest_path = self.root / "manifest.json"
        if self.root == market_dataset_root.resolve():
            raise EpisodeDatasetError("EPISODE_ROOT_MUST_DIFFER_FROM_MARKET_ROOT")
        if self.manifest_path.exists():
            raise EpisodeDatasetError("EPISODE_DATASET_ALREADY_SEALED")

        market = verify_market_dataset(market_dataset_root)
        policy_json = canonical_json(policy)
        policy_hash = hashlib.sha256(policy_json.encode()).hexdigest()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.db_path, autocommit=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        existing = self.db.execute(
            "SELECT dataset_id, schema_version, market_dataset_id, "
            "market_schema_version, market_database_sha256, policy_sha256, policy_json "
            "FROM episode_dataset_metadata"
        ).fetchone()
        expected = (
            dataset_id,
            SCHEMA_VERSION,
            market["datasetId"],
            market["schemaVersion"],
            market["databaseSha256"],
            policy_hash,
            policy_json,
        )
        if existing and tuple(existing) != expected:
            self.db.close()
            raise EpisodeDatasetError("EPISODE_DATASET_IDENTITY_MISMATCH")
        if not existing:
            self.db.execute(
                "INSERT INTO episode_dataset_metadata VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    dataset_id,
                    SCHEMA_VERSION,
                    _utc_now(),
                    market["datasetId"],
                    market["schemaVersion"],
                    market["databaseSha256"],
                    policy_hash,
                    policy_json,
                ),
            )
            self.db.commit()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()

    def close(self) -> None:
        self.db.close()

    def has_candidate_partition(self, decision_date: str) -> bool:
        return (
            self.db.execute(
                "SELECT 1 FROM candidate_partitions WHERE decision_date = ?",
                (decision_date,),
            ).fetchone()
            is not None
        )

    def write_candidate_partition(
        self,
        *,
        decision_date: str,
        execution_date: str,
        universe_count: int,
        universe_sha256: str,
        candidates: list[dict],
        rejections: list[dict],
    ) -> bool:
        if (
            not re.fullmatch(r"\d{8}", decision_date)
            or not re.fullmatch(r"\d{8}", execution_date)
            or execution_date <= decision_date
            or universe_count < 0
            or not re.fullmatch(r"[0-9a-f]{64}", universe_sha256)
        ):
            raise EpisodeDatasetError("CANDIDATE_PARTITION_INVALID")

        normalized_candidates = sorted(
            candidates, key=lambda row: (row["board"], row["rankWithinBoard"])
        )
        identities = [row["instrumentId"] for row in normalized_candidates]
        if len(identities) != len(set(identities)):
            raise EpisodeDatasetError("CANDIDATE_DUPLICATE_INSTRUMENT")
        for row in normalized_candidates:
            if (
                row["board"] not in BOARDS
                or row["rankWithinBoard"] <= 0
                or row["featureSchemaVersion"]
                != json.loads(
                    self.db.execute(
                        "SELECT policy_json FROM episode_dataset_metadata"
                    ).fetchone()[0]
                )["featureSchemaVersion"]
            ):
                raise EpisodeDatasetError("CANDIDATE_ROW_INVALID")

        normalized_rejections = sorted(
            (
                {
                    "board": row["board"],
                    "reason": row["reason"],
                    "instrumentCount": row["instrumentCount"],
                }
                for row in rejections
                if row["instrumentCount"] > 0
            ),
            key=lambda row: (row["board"], row["reason"]),
        )
        if any(row["board"] not in BOARDS for row in normalized_rejections):
            raise EpisodeDatasetError("CANDIDATE_REJECTION_INVALID")
        payload = {
            "decisionDate": decision_date,
            "executionDate": execution_date,
            "universeCount": universe_count,
            "universeSha256": universe_sha256,
            "candidates": normalized_candidates,
            "rejections": normalized_rejections,
        }
        payload_hash = canonical_sha256(payload)
        existing = self.db.execute(
            "SELECT payload_sha256 FROM candidate_partitions WHERE decision_date = ?",
            (decision_date,),
        ).fetchone()
        if existing:
            if existing["payload_sha256"] != payload_hash:
                raise EpisodeDatasetError("CANDIDATE_PARTITION_CONFLICT")
            return False

        try:
            self.db.execute(
                "INSERT INTO candidate_partitions VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    decision_date,
                    execution_date,
                    universe_count,
                    len(normalized_candidates),
                    universe_sha256,
                    payload_hash,
                    _utc_now(),
                ),
            )
            for row in normalized_rejections:
                self.db.execute(
                    "INSERT INTO candidate_partition_rejections VALUES (?, ?, ?, ?)",
                    (
                        decision_date,
                        row["board"],
                        row["reason"],
                        row["instrumentCount"],
                    ),
                )
            for row in normalized_candidates:
                features_json = canonical_json(row["features"])
                identity = {
                    "datasetId": self.dataset_id,
                    "decisionDate": decision_date,
                    "instrumentId": row["instrumentId"],
                }
                source = {
                    "executionDate": execution_date,
                    "featureAvailableAt": row["featureAvailableAt"],
                    "featureSchemaVersion": row["featureSchemaVersion"],
                    "features": row["features"],
                    "rankWithinBoard": row["rankWithinBoard"],
                    "sampleBucket": row["sampleBucket"],
                    "selectionScore": row["selectionScore"],
                }
                self.db.execute(
                    "INSERT INTO candidate_episodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        canonical_sha256(identity),
                        decision_date,
                        execution_date,
                        row["instrumentId"],
                        row["board"],
                        row["rankWithinBoard"],
                        row["sampleBucket"],
                        row["featureAvailableAt"],
                        row["featureSchemaVersion"],
                        features_json,
                        row["selectionScore"],
                        canonical_sha256(source),
                    ),
                )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return True

    @property
    def dataset_id(self) -> str:
        return self.db.execute(
            "SELECT dataset_id FROM episode_dataset_metadata"
        ).fetchone()[0]

    def seal(self) -> dict:
        if self.manifest_path.exists():
            raise EpisodeDatasetError("EPISODE_DATASET_ALREADY_SEALED")
        metadata = dict(
            self.db.execute("SELECT * FROM episode_dataset_metadata").fetchone()
        )
        tables = {
            table: self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in (
                "candidate_partitions",
                "candidate_partition_rejections",
                "candidate_episodes",
            )
        }
        self.db.commit()
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        database_hash = _file_sha256(self.db_path)
        manifest = {
            "datasetId": metadata["dataset_id"],
            "schemaVersion": metadata["schema_version"],
            "createdAt": metadata["created_at"],
            "sealedAt": _utc_now(),
            "database": self.db_path.name,
            "databaseSha256": database_hash,
            "marketDatasetId": metadata["market_dataset_id"],
            "marketSchemaVersion": metadata["market_schema_version"],
            "marketDatabaseSha256": metadata["market_database_sha256"],
            "policySha256": metadata["policy_sha256"],
            "tables": tables,
        }
        temporary = self.manifest_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        )
        os.replace(temporary, self.manifest_path)
        return manifest
