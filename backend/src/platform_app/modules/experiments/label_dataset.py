"""Resumable labels bound to sealed market and episode datasets."""

import hashlib
import json
import os
import re
import sqlite3
from datetime import UTC, datetime
from itertools import groupby
from pathlib import Path

from platform_app.modules.experiments.cash_equity_fees import CASH_EQUITY_FEE_POLICY
from platform_app.modules.experiments.episode_dataset import canonical_json, canonical_sha256
from platform_app.modules.experiments.short_horizon_labeler import (
    LABEL_SIMULATION_POLICY,
    simulate_buy_limit_episode,
)

SCHEMA_VERSION = "label-dataset.v1"

SCHEMA = """
CREATE TABLE IF NOT EXISTS label_dataset_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    dataset_id TEXT NOT NULL UNIQUE,
    schema_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    episode_dataset_id TEXT NOT NULL,
    episode_database_sha256 TEXT NOT NULL,
    market_database_sha256 TEXT NOT NULL,
    simulation_policy_sha256 TEXT NOT NULL,
    simulation_policy_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS label_partitions (
    decision_date TEXT PRIMARY KEY,
    candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
    eligible_count INTEGER NOT NULL CHECK (eligible_count >= 0),
    unavailable_count INTEGER NOT NULL CHECK (unavailable_count >= 0),
    payload_sha256 TEXT NOT NULL,
    completed_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS episode_labels (
    episode_id TEXT PRIMARY KEY,
    decision_date TEXT NOT NULL REFERENCES label_partitions(decision_date),
    instrument_id TEXT NOT NULL,
    board TEXT NOT NULL,
    p_fill_label INTEGER NOT NULL CHECK (p_fill_label IN (0, 1)),
    fill_ratio TEXT NOT NULL,
    filled_shares INTEGER NOT NULL CHECK (filled_shares >= 0),
    target_shares INTEGER NOT NULL CHECK (target_shares > 0),
    entry_price TEXT,
    exit_price TEXT,
    p_win_given_fill_label INTEGER CHECK (p_win_given_fill_label IN (0, 1)),
    net_return_given_fill TEXT,
    stop_hazard_label INTEGER CHECK (stop_hazard_label IN (0, 1)),
    exit_reason TEXT NOT NULL,
    exit_date TEXT,
    buy_fees_cny TEXT,
    sell_fees_cny TEXT,
    source_row_sha256 TEXT NOT NULL
) STRICT;
"""


class LabelDatasetError(ValueError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _verified_manifest(root: Path, expected_schema: str) -> tuple[dict, Path]:
    manifest_path = root.resolve() / "manifest.json"
    if not manifest_path.is_file():
        raise LabelDatasetError("UPSTREAM_DATASET_NOT_SEALED")
    try:
        manifest = json.loads(manifest_path.read_text())
        database = root.resolve() / manifest["database"]
    except (KeyError, json.JSONDecodeError, TypeError) as exc:
        raise LabelDatasetError("UPSTREAM_MANIFEST_INVALID") from exc
    if (
        manifest.get("schemaVersion") != expected_schema
        or not database.is_file()
        or _file_sha256(database) != manifest.get("databaseSha256")
    ):
        raise LabelDatasetError("UPSTREAM_DATASET_INVALID")
    return manifest, database


class LabelDataset:
    def __init__(
        self,
        root: Path,
        *,
        dataset_id: str,
        episode_dataset_root: Path,
        market_dataset_root: Path,
    ):
        self.root = root.resolve()
        self.database_path = self.root / "labels.sqlite3"
        self.manifest_path = self.root / "manifest.json"
        if self.manifest_path.exists():
            raise LabelDatasetError("LABEL_DATASET_ALREADY_SEALED")
        episode_manifest, self.episode_database_path = _verified_manifest(
            episode_dataset_root, "episode-dataset.v4"
        )
        market_manifest, self.market_database_path = _verified_manifest(
            market_dataset_root, "market-dataset.v4"
        )
        if (
            episode_manifest["marketDatabaseSha256"]
            != market_manifest["databaseSha256"]
        ):
            raise LabelDatasetError("LABEL_MARKET_DATASET_MISMATCH")
        simulation_policy = {
            "fees": CASH_EQUITY_FEE_POLICY,
            "labels": LABEL_SIMULATION_POLICY,
        }
        policy_json = canonical_json(simulation_policy)
        policy_hash = hashlib.sha256(policy_json.encode()).hexdigest()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.database_path, autocommit=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        identity = (
            dataset_id,
            SCHEMA_VERSION,
            episode_manifest["datasetId"],
            episode_manifest["databaseSha256"],
            market_manifest["databaseSha256"],
            policy_hash,
            policy_json,
        )
        existing = self.db.execute(
            "SELECT dataset_id, schema_version, episode_dataset_id, "
            "episode_database_sha256, market_database_sha256, "
            "simulation_policy_sha256, simulation_policy_json "
            "FROM label_dataset_metadata"
        ).fetchone()
        if existing and tuple(existing) != identity:
            self.close()
            raise LabelDatasetError("LABEL_DATASET_IDENTITY_MISMATCH")
        if not existing:
            self.db.execute(
                "INSERT INTO label_dataset_metadata VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
                (dataset_id, SCHEMA_VERSION, _now(), *identity[2:]),
            )
            self.db.commit()

        episode_uri = f"{self.episode_database_path.resolve().as_uri()}?mode=ro&immutable=1"
        self.episodes = sqlite3.connect(episode_uri, uri=True)
        self.episodes.row_factory = sqlite3.Row
        market_uri = f"{self.market_database_path.resolve().as_uri()}?mode=ro&immutable=1"
        self.episodes.execute("ATTACH DATABASE ? AS market", (market_uri,))
        policy_row = self.episodes.execute(
            "SELECT policy_json FROM episode_dataset_metadata"
        ).fetchone()
        self.episode_policy = json.loads(policy_row["policy_json"])

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()

    def close(self) -> None:
        self.episodes.close()
        self.db.close()

    def decision_dates(self, start_date: str, end_date: str) -> list[str]:
        return [
            row["decision_date"]
            for row in self.episodes.execute(
                "SELECT decision_date FROM candidate_partitions "
                "WHERE decision_date BETWEEN ? AND ? ORDER BY decision_date",
                (start_date, end_date),
            )
        ]

    def build_range(self, start_date: str, end_date: str):
        for decision_date in self.decision_dates(start_date, end_date):
            yield self.build_partition(decision_date)

    def build_partition(self, decision_date: str) -> dict:
        if not re.fullmatch(r"\d{8}", decision_date):
            raise LabelDatasetError("LABEL_PARTITION_DATE_INVALID")
        existing = self.db.execute(
            "SELECT candidate_count, eligible_count, unavailable_count "
            "FROM label_partitions WHERE decision_date = ?",
            (decision_date,),
        ).fetchone()
        if existing:
            return {
                "decisionDate": decision_date,
                "status": "SKIPPED",
                "candidateCount": existing["candidate_count"],
                "eligibleCount": existing["eligible_count"],
                "unavailableCount": existing["unavailable_count"],
            }

        candidate_count = self.episodes.execute(
            "SELECT COUNT(*) FROM candidate_episodes WHERE decision_date = ?",
            (decision_date,),
        ).fetchone()[0]
        rows = self.episodes.execute(
            "WITH eligible AS ("
            "SELECT e.episode_id, e.instrument_id, e.board, e.decision_date "
            "FROM candidate_episodes e "
            "JOIN episode_minute_requirements l ON l.episode_id = e.episode_id "
            "JOIN minute_requirements r "
            "ON r.instrument_id = l.instrument_id AND r.trade_date = l.trade_date "
            "WHERE e.decision_date = ? GROUP BY e.episode_id "
            "HAVING COUNT(*) = 5 AND SUM(r.status = 'COMPLETED') = 5"
            ") "
            "SELECT e.episode_id, e.instrument_id, e.board, d0.close AS decision_close, "
            "l.session_offset, l.trade_date, b.bar_end_shanghai, b.open, b.high, "
            "b.low, b.close, b.volume_shares, d4.close AS terminal_close "
            "FROM eligible e "
            "JOIN episode_minute_requirements l ON l.episode_id = e.episode_id "
            "JOIN episode_minute_bars b "
            "ON b.instrument_id = l.instrument_id "
            "AND b.bar_end_shanghai >= "
            "(substr(l.trade_date, 1, 4) || '-' || substr(l.trade_date, 5, 2) || '-' "
            "|| substr(l.trade_date, 7, 2) || ' 00:00:00') "
            "AND b.bar_end_shanghai < "
            "(substr(l.trade_date, 1, 4) || '-' || substr(l.trade_date, 5, 2) || '-' "
            "|| substr(l.trade_date, 7, 2) || ' 99:99:99') "
            "AND b.trade_date = l.trade_date "
            "JOIN episode_minute_requirements terminal "
            "ON terminal.episode_id = e.episode_id AND terminal.session_offset = 4 "
            "JOIN market.daily_bars d0 "
            "ON d0.instrument_id = e.instrument_id AND d0.trade_date = e.decision_date "
            "JOIN market.daily_bars d4 "
            "ON d4.instrument_id = e.instrument_id AND d4.trade_date = terminal.trade_date "
            "ORDER BY e.episode_id, l.session_offset, b.bar_end_shanghai",
            (decision_date,),
        )
        labels = []
        for episode_id, group in groupby(rows, key=lambda row: row["episode_id"]):
            episode_rows = [dict(row) for row in group]
            first = episode_rows[0]
            trade_dates = list(
                dict.fromkeys(row["trade_date"] for row in episode_rows)
            )
            bars = [
                {
                    "tradeDate": row["trade_date"],
                    "barEndShanghai": row["bar_end_shanghai"],
                    "open": row["open"],
                    "high": row["high"],
                    "low": row["low"],
                    "close": row["close"],
                    "volumeShares": row["volume_shares"],
                }
                for row in episode_rows
            ]
            label = simulate_buy_limit_episode(
                instrument_id=first["instrument_id"],
                board=first["board"],
                decision_date=decision_date,
                trade_dates=trade_dates,
                decision_close=first["decision_close"],
                bars=bars,
                terminal_close=first["terminal_close"],
                execution_policy=self.episode_policy["executionPolicy"],
                label_policy=self.episode_policy["labelPolicy"],
            )
            labels.append({"episodeId": episode_id, **label})

        unavailable_count = candidate_count - len(labels)
        payload_hash = canonical_sha256(
            {
                "decisionDate": decision_date,
                "candidateCount": candidate_count,
                "unavailableCount": unavailable_count,
                "labels": labels,
            }
        )
        try:
            self.db.execute(
                "INSERT INTO label_partitions VALUES (?, ?, ?, ?, ?, ?)",
                (
                    decision_date,
                    candidate_count,
                    len(labels),
                    unavailable_count,
                    payload_hash,
                    _now(),
                ),
            )
            for row in labels:
                source_hash = canonical_sha256(row)
                self.db.execute(
                    "INSERT INTO episode_labels VALUES "
                    "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        row["episodeId"],
                        decision_date,
                        row["instrumentId"],
                        row["board"],
                        row["pFillLabel"],
                        row["fillRatio"],
                        row["filledShares"],
                        row["targetShares"],
                        row.get("entryPrice"),
                        row.get("exitPrice"),
                        row["pWinGivenFillLabel"],
                        row["netReturnGivenFill"],
                        row["stopHazardLabel"],
                        row["exitReason"],
                        row["exitDate"],
                        row.get("buyFeesCny"),
                        row.get("sellFeesCny"),
                        source_hash,
                    ),
                )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return {
            "decisionDate": decision_date,
            "status": "COMPLETED",
            "candidateCount": candidate_count,
            "eligibleCount": len(labels),
            "unavailableCount": unavailable_count,
        }

    def seal(self) -> dict:
        expected_partitions = self.episodes.execute(
            "SELECT COUNT(*) FROM candidate_partitions"
        ).fetchone()[0]
        completed_partitions = self.db.execute(
            "SELECT COUNT(*) FROM label_partitions"
        ).fetchone()[0]
        if completed_partitions != expected_partitions:
            raise LabelDatasetError("LABEL_PARTITIONS_INCOMPLETE")
        metadata = dict(self.db.execute("SELECT * FROM label_dataset_metadata").fetchone())
        totals = dict(
            self.db.execute(
                "SELECT COUNT(*) AS labels, SUM(p_fill_label) AS fills, "
                "SUM(CASE WHEN p_fill_label = 1 THEN p_win_given_fill_label ELSE 0 END) "
                "AS wins, SUM(CASE WHEN p_fill_label = 1 THEN stop_hazard_label ELSE 0 END) "
                "AS stops FROM episode_labels"
            ).fetchone()
        )
        board_counts = {
            row["board"]: row["count"]
            for row in self.db.execute(
                "SELECT board, COUNT(*) AS count FROM episode_labels GROUP BY board"
            )
        }
        self.db.commit()
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        database_hash = _file_sha256(self.database_path)
        manifest = {
            "datasetId": metadata["dataset_id"],
            "schemaVersion": metadata["schema_version"],
            "createdAt": metadata["created_at"],
            "sealedAt": _now(),
            "database": self.database_path.name,
            "databaseSha256": database_hash,
            "episodeDatasetId": metadata["episode_dataset_id"],
            "episodeDatabaseSha256": metadata["episode_database_sha256"],
            "marketDatabaseSha256": metadata["market_database_sha256"],
            "simulationPolicySha256": metadata["simulation_policy_sha256"],
            "partitions": completed_partitions,
            "labels": totals,
            "labelsByBoard": board_counts,
        }
        temporary = self.manifest_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        )
        os.replace(temporary, self.manifest_path)
        return manifest
