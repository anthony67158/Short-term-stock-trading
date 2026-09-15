"""Immutable, resumable storage for normalized historical market datasets."""

import hashlib
import json
import os
import sqlite3
from datetime import UTC, datetime
from pathlib import Path


class MarketDatasetError(ValueError):
    pass


SCHEMA_VERSION = "market-dataset.v1"

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS dataset_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    dataset_id TEXT NOT NULL UNIQUE,
    schema_version TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS instruments (
    instrument_id TEXT PRIMARY KEY,
    source_code TEXT NOT NULL UNIQUE,
    exchange TEXT NOT NULL,
    board TEXT NOT NULL,
    name TEXT NOT NULL,
    list_status TEXT NOT NULL CHECK (list_status IN ('L', 'D', 'P')),
    list_date TEXT NOT NULL,
    delist_date TEXT,
    source TEXT NOT NULL,
    available_at TEXT NOT NULL,
    source_row_sha256 TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS instrument_aliases (
    source_code TEXT PRIMARY KEY,
    instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    reason TEXT NOT NULL,
    source TEXT NOT NULL,
    available_at TEXT NOT NULL,
    source_row_sha256 TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS daily_bars (
    instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
    source_code TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    open TEXT NOT NULL,
    high TEXT NOT NULL,
    low TEXT NOT NULL,
    close TEXT NOT NULL,
    previous_close TEXT NOT NULL,
    volume_shares TEXT NOT NULL,
    amount_cny TEXT NOT NULL,
    adjustment TEXT NOT NULL CHECK (adjustment = 'RAW'),
    source TEXT NOT NULL,
    available_at TEXT NOT NULL,
    source_row_sha256 TEXT NOT NULL,
    PRIMARY KEY (instrument_id, trade_date)
) STRICT;
CREATE TABLE IF NOT EXISTS sync_checkpoints (
    stream TEXT NOT NULL,
    partition_key TEXT NOT NULL,
    row_count INTEGER NOT NULL CHECK (row_count >= 0),
    payload_sha256 TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (stream, partition_key)
) STRICT;
"""


def canonical_sha256(value: dict | list) -> str:
    payload = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(payload).hexdigest()


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


class MarketDataset:
    def __init__(self, root: Path, *, dataset_id: str, source: str):
        self.root = root.resolve()
        self.db_path = self.root / "market.sqlite3"
        self.manifest_path = self.root / "manifest.json"
        if self.manifest_path.exists():
            raise MarketDatasetError("DATASET_ALREADY_SEALED")
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.db_path, autocommit=False)
        self.sealed = False
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        existing = self.db.execute(
            "SELECT dataset_id, schema_version, source FROM dataset_metadata"
        ).fetchone()
        expected = (dataset_id, SCHEMA_VERSION, source)
        if existing and tuple(existing) != expected:
            self.db.close()
            raise MarketDatasetError("DATASET_IDENTITY_MISMATCH")
        if not existing:
            self.db.execute(
                "INSERT INTO dataset_metadata VALUES (1, ?, ?, ?, ?)",
                (dataset_id, SCHEMA_VERSION, source, _utc_now()),
            )
        self.db.commit()

    def close(self):
        self.db.close()

    def _assert_writable(self):
        if self.sealed or self.manifest_path.exists():
            raise MarketDatasetError("DATASET_ALREADY_SEALED")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()

    def _insert_exact(self, table: str, keys: dict, values: dict) -> bool:
        self._assert_writable()
        row = {**keys, **values}
        where = " AND ".join(f"{column} = ?" for column in keys)
        current = self.db.execute(
            f"SELECT {', '.join(row)} FROM {table} WHERE {where}",
            tuple(keys.values()),
        ).fetchone()
        if current:
            if dict(current) != row:
                raise MarketDatasetError("DATASET_CONFLICT")
            return False
        placeholders = ", ".join("?" for _ in row)
        self.db.execute(
            f"INSERT INTO {table} ({', '.join(row)}) VALUES ({placeholders})",
            tuple(row.values()),
        )
        return True

    def write_instruments(self, rows: list[dict]) -> int:
        inserted = 0
        try:
            for row in rows:
                inserted += self._insert_exact(
                    "instruments",
                    {"instrument_id": row["instrumentId"]},
                    {
                        "source_code": row["sourceCode"],
                        "exchange": row["exchange"],
                        "board": row["board"],
                        "name": row["name"],
                        "list_status": row["listStatus"],
                        "list_date": row["listDate"],
                        "delist_date": row.get("delistDate"),
                        "source": row["source"],
                        "available_at": row["availableAt"],
                        "source_row_sha256": row["sourceRowSha256"],
                    },
                )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return inserted

    def write_aliases(self, rows: list[dict]) -> int:
        inserted = 0
        try:
            for row in rows:
                inserted += self._insert_exact(
                    "instrument_aliases",
                    {"source_code": row["sourceCode"]},
                    {
                        "instrument_id": row["instrumentId"],
                        "effective_from": row["effectiveFrom"],
                        "effective_to": row.get("effectiveTo"),
                        "reason": row["reason"],
                        "source": row["source"],
                        "available_at": row["availableAt"],
                        "source_row_sha256": row["sourceRowSha256"],
                    },
                )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return inserted

    def write_daily_bars(self, rows: list[dict], *, source: str, available_at: str) -> int:
        inserted = 0
        try:
            for row in rows:
                inserted += self._insert_exact(
                    "daily_bars",
                    {
                        "instrument_id": row["instrumentId"],
                        "trade_date": row["tradeDate"],
                    },
                    {
                        "source_code": row["sourceCode"],
                        "open": row["open"],
                        "high": row["high"],
                        "low": row["low"],
                        "close": row["close"],
                        "previous_close": row["previousClose"],
                        "volume_shares": row["volumeShares"],
                        "amount_cny": row["amountCny"],
                        "adjustment": row["adjustment"],
                        "source": source,
                        "available_at": available_at,
                        "source_row_sha256": row["sourceRowSha256"],
                    },
                )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return inserted

    def checkpoint(self, stream: str, partition_key: str, rows: list[dict]) -> bool:
        values = {
            "row_count": len(rows),
            "payload_sha256": canonical_sha256(rows),
            "completed_at": _utc_now(),
        }
        try:
            current = self.db.execute(
                "SELECT row_count, payload_sha256 FROM sync_checkpoints "
                "WHERE stream = ? AND partition_key = ?",
                (stream, partition_key),
            ).fetchone()
            if current:
                if (
                    current["row_count"] != values["row_count"]
                    or current["payload_sha256"] != values["payload_sha256"]
                ):
                    raise MarketDatasetError("CHECKPOINT_CONFLICT")
                return False
            self.db.execute(
                "INSERT INTO sync_checkpoints VALUES (?, ?, ?, ?, ?)",
                (stream, partition_key, *values.values()),
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return True

    def has_checkpoint(self, stream: str, partition_key: str) -> bool:
        return self.db.execute(
            "SELECT 1 FROM sync_checkpoints WHERE stream = ? AND partition_key = ?",
            (stream, partition_key),
        ).fetchone() is not None

    def seal(self) -> dict:
        self._assert_writable()
        metadata = dict(self.db.execute("SELECT * FROM dataset_metadata").fetchone())
        tables = {}
        for table in ("instruments", "instrument_aliases", "daily_bars", "sync_checkpoints"):
            tables[table] = self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        self.db.commit()
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        with self.db_path.open("rb") as stream:
            database_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        manifest = {
            "datasetId": metadata["dataset_id"],
            "schemaVersion": metadata["schema_version"],
            "source": metadata["source"],
            "createdAt": metadata["created_at"],
            "sealedAt": _utc_now(),
            "database": self.db_path.name,
            "databaseSha256": database_hash,
            "tables": tables,
        }
        temporary = self.manifest_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        )
        os.replace(temporary, self.manifest_path)
        self.sealed = True
        return manifest
