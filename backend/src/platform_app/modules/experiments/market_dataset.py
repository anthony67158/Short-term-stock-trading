"""Immutable, resumable storage for normalized historical market datasets."""

import hashlib
import json
import os
import sqlite3
from datetime import UTC, datetime
from pathlib import Path


class MarketDatasetError(ValueError):
    pass


SCHEMA_VERSION = "market-dataset.v3"

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
    source_list_date TEXT NOT NULL,
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
    source_urls_json TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS trade_calendar (
    exchange TEXT NOT NULL,
    cal_date TEXT NOT NULL,
    is_open INTEGER NOT NULL CHECK (is_open IN (0, 1)),
    previous_open_date TEXT,
    source TEXT NOT NULL,
    available_at TEXT NOT NULL,
    source_row_sha256 TEXT NOT NULL,
    PRIMARY KEY (exchange, cal_date)
) STRICT;
CREATE TABLE IF NOT EXISTS adjustment_factors (
    instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
    source_code TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    factor TEXT NOT NULL,
    source TEXT NOT NULL,
    available_at TEXT NOT NULL,
    source_row_sha256 TEXT NOT NULL,
    PRIMARY KEY (instrument_id, trade_date)
) STRICT;
CREATE TABLE IF NOT EXISTS suspensions (
    instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
    source_code TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    suspend_type TEXT NOT NULL,
    suspend_timing TEXT NOT NULL,
    source TEXT NOT NULL,
    available_at TEXT NOT NULL,
    source_row_sha256 TEXT NOT NULL,
    PRIMARY KEY (instrument_id, trade_date, suspend_type, suspend_timing)
) STRICT;
CREATE TABLE IF NOT EXISTS listing_status_periods (
    instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
    status TEXT NOT NULL CHECK (status IN ('SUSPENDED_LISTING')),
    effective_from TEXT NOT NULL,
    effective_to TEXT NOT NULL,
    source TEXT NOT NULL,
    source_urls_json TEXT NOT NULL,
    evidence_observed_at TEXT NOT NULL,
    source_row_sha256 TEXT NOT NULL,
    PRIMARY KEY (instrument_id, status, effective_from),
    CHECK (effective_to > effective_from)
) STRICT;
CREATE TABLE IF NOT EXISTS name_changes (
    instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
    source_code TEXT NOT NULL,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT,
    announced_date TEXT,
    reason TEXT,
    source TEXT NOT NULL,
    available_at TEXT NOT NULL,
    source_row_sha256 TEXT NOT NULL,
    PRIMARY KEY (instrument_id, start_date, name)
) STRICT;
CREATE TABLE IF NOT EXISTS minute_bars (
    instrument_id TEXT NOT NULL REFERENCES instruments(instrument_id),
    source_code TEXT NOT NULL,
    bar_end_shanghai TEXT NOT NULL,
    frequency TEXT NOT NULL CHECK (frequency = '5min'),
    open TEXT NOT NULL,
    high TEXT NOT NULL,
    low TEXT NOT NULL,
    close TEXT NOT NULL,
    volume_shares TEXT NOT NULL,
    amount_cny TEXT NOT NULL,
    adjustment TEXT NOT NULL CHECK (adjustment = 'RAW'),
    source TEXT NOT NULL,
    available_at TEXT NOT NULL,
    source_row_sha256 TEXT NOT NULL,
    PRIMARY KEY (instrument_id, bar_end_shanghai, frequency)
) STRICT;
CREATE TABLE IF NOT EXISTS sync_checkpoints (
    stream TEXT NOT NULL,
    partition_key TEXT NOT NULL,
    row_count INTEGER NOT NULL CHECK (row_count >= 0),
    payload_sha256 TEXT NOT NULL,
    source TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    available_at TEXT NOT NULL,
    availability_method TEXT NOT NULL,
    details_json TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (stream, partition_key)
) STRICT;
"""


def canonical_sha256(value: dict | list) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
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

    def _insert_exact(
        self,
        table: str,
        keys: dict,
        values: dict,
        *,
        ignored_on_replay: tuple[str, ...] = (),
    ) -> bool:
        self._assert_writable()
        row = {**keys, **values}
        where = " AND ".join(f"{column} = ?" for column in keys)
        current = self.db.execute(
            f"SELECT {', '.join(row)} FROM {table} WHERE {where}",
            tuple(keys.values()),
        ).fetchone()
        if current:
            current_values = dict(current)
            if any(
                current_values[field] != value
                for field, value in row.items()
                if field not in ignored_on_replay
            ):
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
                        "source_list_date": row.get("sourceListDate", row["listDate"]),
                        "delist_date": row.get("delistDate"),
                        "source": row["source"],
                        "available_at": row["availableAt"],
                        "source_row_sha256": row["sourceRowSha256"],
                    },
                    ignored_on_replay=("available_at",),
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
                        "source_urls_json": row.get("sourceUrlsJson", "[]"),
                        "available_at": row["availableAt"],
                        "source_row_sha256": row["sourceRowSha256"],
                    },
                    ignored_on_replay=("available_at",),
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

    def write_facts(
        self,
        table: str,
        rows: list[dict],
        *,
        key_fields: tuple[str, ...],
        ignored_on_replay: tuple[str, ...] = (),
    ) -> int:
        allowed = {
            "trade_calendar",
            "adjustment_factors",
            "suspensions",
            "listing_status_periods",
            "name_changes",
            "minute_bars",
        }
        if table not in allowed:
            raise MarketDatasetError("DATASET_TABLE_REJECTED")
        inserted = 0
        try:
            for row in rows:
                keys = {field: row[field] for field in key_fields}
                values = {field: value for field, value in row.items() if field not in keys}
                inserted += self._insert_exact(
                    table,
                    keys,
                    values,
                    ignored_on_replay=ignored_on_replay,
                )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return inserted

    def eligible_instruments(self, trade_date: str) -> list[str]:
        rows = self.db.execute(
            "SELECT instrument_id FROM instruments "
            "WHERE list_date <= ? AND (delist_date IS NULL OR delist_date > ?) "
            "ORDER BY instrument_id",
            (trade_date, trade_date),
        )
        return [row["instrument_id"] for row in rows]

    def instrument_lifecycles(self) -> dict[str, dict[str, str | None]]:
        rows = self.db.execute(
            "SELECT instrument_id, board, list_date, source_list_date, delist_date "
            "FROM instruments ORDER BY instrument_id"
        )
        return {
            row["instrument_id"]: {
                "board": row["board"],
                "list_date": row["list_date"],
                "source_list_date": row["source_list_date"],
                "delist_date": row["delist_date"],
            }
            for row in rows
        }

    def source_code_for_date(self, instrument_id: str, trade_date: str) -> str:
        alias = self.db.execute(
            "SELECT source_code FROM instrument_aliases "
            "WHERE instrument_id = ? AND effective_from <= ? "
            "AND (effective_to IS NULL OR effective_to >= ?) "
            "ORDER BY effective_from DESC",
            (instrument_id, trade_date, trade_date),
        ).fetchone()
        if alias:
            return alias["source_code"]
        instrument = self.db.execute(
            "SELECT source_code FROM instruments WHERE instrument_id = ?",
            (instrument_id,),
        ).fetchone()
        if not instrument:
            raise MarketDatasetError("UNKNOWN_INSTRUMENT")
        return instrument["source_code"]

    def suspension_explanations(self, trade_date: str) -> dict[str, list[str]]:
        rows = self.db.execute(
            "SELECT instrument_id, suspend_type, suspend_timing FROM suspensions "
            "WHERE trade_date = ? ORDER BY instrument_id, suspend_type, suspend_timing",
            (trade_date,),
        )
        result: dict[str, list[str]] = {}
        for row in rows:
            result.setdefault(row["instrument_id"], []).append(
                f"{row['suspend_type']}:{row['suspend_timing']}"
            )
        return result

    def listing_status_explanations(self, trade_date: str) -> dict[str, list[str]]:
        rows = self.db.execute(
            "SELECT instrument_id, status FROM listing_status_periods "
            "WHERE effective_from <= ? AND effective_to > ? "
            "ORDER BY instrument_id, status",
            (trade_date, trade_date),
        )
        result: dict[str, list[str]] = {}
        for row in rows:
            result.setdefault(row["instrument_id"], []).append(row["status"])
        return result

    def checkpoint(
        self,
        stream: str,
        partition_key: str,
        rows: list[dict],
        *,
        source: str | None = None,
        first_seen_at: str | None = None,
        available_at: str | None = None,
        availability_method: str = "DIRECT_OBSERVATION",
        details: dict | None = None,
    ) -> bool:
        observed_at = first_seen_at or _utc_now()
        values = {
            "row_count": len(rows),
            "payload_sha256": canonical_sha256(rows),
            "source": source
            or self.db.execute("SELECT source FROM dataset_metadata").fetchone()[0],
            "first_seen_at": observed_at,
            "available_at": available_at or observed_at,
            "availability_method": availability_method,
            "details_json": json.dumps(
                details or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ),
            "completed_at": _utc_now(),
        }
        try:
            current = self.db.execute(
                "SELECT row_count, payload_sha256, details_json FROM sync_checkpoints "
                "WHERE stream = ? AND partition_key = ?",
                (stream, partition_key),
            ).fetchone()
            if current:
                if (
                    current["row_count"] != values["row_count"]
                    or current["payload_sha256"] != values["payload_sha256"]
                    or current["details_json"] != values["details_json"]
                ):
                    raise MarketDatasetError("CHECKPOINT_CONFLICT")
                return False
            self.db.execute(
                "INSERT INTO sync_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (stream, partition_key, *values.values()),
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return True

    def has_checkpoint(self, stream: str, partition_key: str) -> bool:
        return (
            self.db.execute(
                "SELECT 1 FROM sync_checkpoints WHERE stream = ? AND partition_key = ?",
                (stream, partition_key),
            ).fetchone()
            is not None
        )

    def seal(self) -> dict:
        self._assert_writable()
        metadata = dict(self.db.execute("SELECT * FROM dataset_metadata").fetchone())
        tables = {}
        for table in (
            "instruments",
            "instrument_aliases",
            "trade_calendar",
            "daily_bars",
            "adjustment_factors",
            "suspensions",
            "listing_status_periods",
            "name_changes",
            "minute_bars",
            "sync_checkpoints",
        ):
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
