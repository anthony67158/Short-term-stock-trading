"""Resumable paired counterfactual position-action labels."""

import hashlib
import json
import os
import sqlite3
from datetime import UTC, datetime
from itertools import groupby
from pathlib import Path

from platform_app.modules.experiments.episode_dataset import (
    canonical_json,
    canonical_sha256,
)
from platform_app.modules.experiments.position_action_labeler import (
    POSITION_ACTION_POLICY,
    label_position_actions,
)

SCHEMA_VERSION = "position-action-dataset.v1"
SCHEMA = """
CREATE TABLE IF NOT EXISTS position_action_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    dataset_id TEXT NOT NULL UNIQUE,
    schema_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    episode_dataset_id TEXT NOT NULL,
    episode_database_sha256 TEXT NOT NULL,
    label_dataset_id TEXT NOT NULL,
    label_database_sha256 TEXT NOT NULL,
    market_database_sha256 TEXT NOT NULL,
    policy_sha256 TEXT NOT NULL,
    policy_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS position_action_partitions (
    decision_date TEXT PRIMARY KEY,
    full_fill_scenarios INTEGER NOT NULL,
    label_count INTEGER NOT NULL,
    payload_sha256 TEXT NOT NULL,
    completed_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS position_action_labels (
    episode_id TEXT NOT NULL,
    current_shares INTEGER NOT NULL CHECK (current_shares > 0),
    decision_date TEXT NOT NULL REFERENCES position_action_partitions(decision_date),
    instrument_id TEXT NOT NULL,
    board TEXT NOT NULL,
    snapshot_date TEXT NOT NULL,
    action_date TEXT NOT NULL,
    terminal_date TEXT NOT NULL,
    snapshot_price TEXT NOT NULL,
    action_open TEXT NOT NULL,
    terminal_close TEXT NOT NULL,
    action_capacity_shares INTEGER NOT NULL,
    add_filled_shares INTEGER NOT NULL,
    reduce_filled_shares INTEGER NOT NULL,
    exit_filled_shares INTEGER NOT NULL,
    hold_value_cny TEXT NOT NULL,
    add_value_cny TEXT NOT NULL,
    reduce_value_cny TEXT NOT NULL,
    exit_value_cny TEXT NOT NULL,
    add_delta_return TEXT NOT NULL,
    reduce_delta_return TEXT NOT NULL,
    exit_delta_return TEXT NOT NULL,
    best_action TEXT NOT NULL CHECK (best_action IN ('HOLD', 'ADD', 'REDUCE', 'EXIT')),
    source_row_sha256 TEXT NOT NULL,
    PRIMARY KEY (episode_id, current_shares)
) STRICT, WITHOUT ROWID;
"""


class PositionActionDatasetError(ValueError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _verified_manifest(root: Path, expected_schema: str) -> tuple[dict, Path]:
    manifest_path = root.resolve() / "manifest.json"
    if not manifest_path.is_file():
        raise PositionActionDatasetError("POSITION_ACTION_INPUT_NOT_SEALED")
    manifest = json.loads(manifest_path.read_text())
    database = root.resolve() / manifest["database"]
    if (
        manifest.get("schemaVersion") != expected_schema
        or not database.is_file()
        or _file_sha256(database) != manifest.get("databaseSha256")
    ):
        raise PositionActionDatasetError("POSITION_ACTION_INPUT_INVALID")
    return manifest, database


class PositionActionDataset:
    def __init__(
        self,
        root: Path,
        *,
        dataset_id: str,
        episode_dataset_root: Path,
        label_dataset_root: Path,
        market_dataset_root: Path,
    ):
        self.root = root.resolve()
        self.database_path = self.root / "position-actions.sqlite3"
        self.manifest_path = self.root / "manifest.json"
        if self.manifest_path.exists():
            raise PositionActionDatasetError("POSITION_ACTION_DATASET_ALREADY_SEALED")
        episode_manifest, episode_path = _verified_manifest(
            episode_dataset_root,
            "episode-dataset.v4",
        )
        label_manifest, label_path = _verified_manifest(
            label_dataset_root,
            "label-dataset.v2",
        )
        market_manifest, market_path = _verified_manifest(
            market_dataset_root,
            "market-dataset.v4",
        )
        if (
            label_manifest["episodeDatabaseSha256"]
            != episode_manifest["databaseSha256"]
            or episode_manifest["marketDatabaseSha256"]
            != market_manifest["databaseSha256"]
        ):
            raise PositionActionDatasetError("POSITION_ACTION_LINEAGE_MISMATCH")
        policy_json = canonical_json(POSITION_ACTION_POLICY)
        identity = (
            dataset_id,
            SCHEMA_VERSION,
            episode_manifest["datasetId"],
            episode_manifest["databaseSha256"],
            label_manifest["datasetId"],
            label_manifest["databaseSha256"],
            market_manifest["databaseSha256"],
            hashlib.sha256(policy_json.encode()).hexdigest(),
            policy_json,
        )
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.database_path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        existing = self.db.execute(
            "SELECT dataset_id,schema_version,episode_dataset_id,"
            "episode_database_sha256,label_dataset_id,label_database_sha256,"
            "market_database_sha256,policy_sha256,policy_json "
            "FROM position_action_metadata"
        ).fetchone()
        if existing and tuple(existing) != identity:
            self.close()
            raise PositionActionDatasetError("POSITION_ACTION_IDENTITY_MISMATCH")
        if not existing:
            self.db.execute(
                "INSERT INTO position_action_metadata VALUES "
                "(1,?,?,?,?,?,?,?,?,?,?)",
                (dataset_id, SCHEMA_VERSION, _now(), *identity[2:]),
            )
            self.db.commit()
        self.source = sqlite3.connect(
            f"{label_path.resolve().as_uri()}?mode=ro&immutable=1",
            uri=True,
        )
        self.source.row_factory = sqlite3.Row
        self.source.execute(
            "ATTACH DATABASE ? AS episodes",
            (f"{episode_path.resolve().as_uri()}?mode=ro&immutable=1",),
        )
        self.source.execute(
            "ATTACH DATABASE ? AS market",
            (f"{market_path.resolve().as_uri()}?mode=ro&immutable=1",),
        )

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()

    def close(self) -> None:
        self.source.close()
        self.db.close()

    def decision_dates(self, start_date: str, end_date: str) -> list[str]:
        return [
            row["decision_date"]
            for row in self.source.execute(
                "SELECT decision_date FROM label_partitions "
                "WHERE decision_date BETWEEN ? AND ? ORDER BY decision_date",
                (start_date, end_date),
            )
        ]

    def build_range(self, start_date: str, end_date: str):
        dates = self.decision_dates(start_date, end_date)
        completed = {
            row["decision_date"]
            for row in self.db.execute(
                "SELECT decision_date FROM position_action_partitions "
                "WHERE decision_date BETWEEN ? AND ?",
                (start_date, end_date),
            )
        }
        pending = [decision_date for decision_date in dates if decision_date not in completed]
        grouped_rows = iter(())
        current = None
        if pending:
            grouped_rows = iter(
                groupby(
                    self._source_rows(pending[0], pending[-1]),
                    key=lambda row: row["decision_date"],
                )
            )
            current = next(grouped_rows, None)
        for decision_date in dates:
            if decision_date in completed:
                existing = self.db.execute(
                    "SELECT full_fill_scenarios,label_count "
                    "FROM position_action_partitions WHERE decision_date=?",
                    (decision_date,),
                ).fetchone()
                yield {
                    "decisionDate": decision_date,
                    "status": "SKIPPED",
                    "fullFillScenarios": existing["full_fill_scenarios"],
                    "labels": existing["label_count"],
                }
                continue
            while current and current[0] < decision_date:
                current = next(grouped_rows, None)
            date_rows = list(current[1]) if current and current[0] == decision_date else []
            if current and current[0] == decision_date:
                current = next(grouped_rows, None)
            yield self._write_partition(
                decision_date,
                self._labels_from_rows(decision_date, date_rows),
            )

    def build_partition(self, decision_date: str) -> dict:
        existing = self.db.execute(
            "SELECT full_fill_scenarios,label_count FROM position_action_partitions "
            "WHERE decision_date=?",
            (decision_date,),
        ).fetchone()
        if existing:
            return {
                "decisionDate": decision_date,
                "status": "SKIPPED",
                "fullFillScenarios": existing["full_fill_scenarios"],
                "labels": existing["label_count"],
            }
        return self._write_partition(
            decision_date,
            self._labels_from_rows(
                decision_date,
                list(self._source_rows(decision_date, decision_date)),
            ),
        )

    def _source_rows(self, start_date: str, end_date: str):
        return self.source.execute(
            "SELECT l.episode_id,l.instrument_id,l.board,l.target_shares,"
            "l.decision_date,"
            "r0.trade_date AS snapshot_date,r1.trade_date AS action_date,"
            "r4.trade_date AS terminal_date,d0.close AS snapshot_price,"
            "d1.open AS action_open,d4.close AS terminal_close,"
            "b.trade_date,b.bar_end_shanghai,b.volume_shares "
            "FROM episode_labels l "
            "JOIN episodes.episode_minute_requirements r0 "
            "ON r0.episode_id=l.episode_id AND r0.session_offset=0 "
            "JOIN episodes.episode_minute_requirements r1 "
            "ON r1.episode_id=l.episode_id AND r1.session_offset=1 "
            "JOIN episodes.episode_minute_requirements r4 "
            "ON r4.episode_id=l.episode_id AND r4.session_offset=4 "
            "JOIN market.daily_bars d0 ON d0.instrument_id=l.instrument_id "
            "AND d0.trade_date=r0.trade_date "
            "JOIN market.daily_bars d1 ON d1.instrument_id=l.instrument_id "
            "AND d1.trade_date=r1.trade_date "
            "JOIN market.daily_bars d4 ON d4.instrument_id=l.instrument_id "
            "AND d4.trade_date=r4.trade_date "
            "JOIN episodes.episode_minute_bars b "
            "ON b.instrument_id=l.instrument_id "
            "AND b.bar_end_shanghai >= "
            "(substr(r1.trade_date,1,4) || '-' || substr(r1.trade_date,5,2) || '-' "
            "|| substr(r1.trade_date,7,2) || ' 00:00:00') "
            "AND b.bar_end_shanghai < "
            "(substr(r1.trade_date,1,4) || '-' || substr(r1.trade_date,5,2) || '-' "
            "|| substr(r1.trade_date,7,2) || ' 99:99:99') "
            "AND b.trade_date=r1.trade_date "
            "WHERE l.decision_date BETWEEN ? AND ? AND l.p_full_fill_label=1 "
            "AND substr(b.bar_end_shanghai,-8) <= '10:00:00' "
            "ORDER BY l.decision_date,l.episode_id,l.target_shares,b.bar_end_shanghai",
            (start_date, end_date),
        )

    @staticmethod
    def _labels_from_rows(decision_date: str, rows: list[sqlite3.Row]) -> list[dict]:
        labels = []
        for (_episode_id, _current_shares), group in groupby(
            rows,
            key=lambda row: (row["episode_id"], row["target_shares"]),
        ):
            group_rows = list(group)
            first = group_rows[0]
            result = label_position_actions(
                board=first["board"],
                current_shares=first["target_shares"],
                snapshot_price=first["snapshot_price"],
                action_date=first["action_date"],
                action_open=first["action_open"],
                action_bars=[
                    {
                        "tradeDate": row["trade_date"],
                        "barEndShanghai": row["bar_end_shanghai"],
                        "volumeShares": row["volume_shares"],
                    }
                    for row in group_rows
                ],
                terminal_date=first["terminal_date"],
                terminal_close=first["terminal_close"],
            )
            labels.append(
                {
                    "episodeId": first["episode_id"],
                    "decisionDate": decision_date,
                    "instrumentId": first["instrument_id"],
                    "board": first["board"],
                    "snapshotDate": first["snapshot_date"],
                    **result,
                }
            )
        return labels

    def _write_partition(self, decision_date: str, labels: list[dict]) -> dict:
        payload_hash = canonical_sha256(
            {"decisionDate": decision_date, "labels": labels}
        )
        try:
            self.db.execute(
                "INSERT INTO position_action_partitions VALUES (?,?,?,?,?)",
                (decision_date, len(labels), len(labels), payload_hash, _now()),
            )
            records = []
            for row in labels:
                values = row["actionValuesCny"]
                deltas = row["deltaReturnVsHold"]
                fills = row["actionFilledShares"]
                records.append(
                    (
                        row["episodeId"],
                        row["currentShares"],
                        decision_date,
                        row["instrumentId"],
                        row["board"],
                        row["snapshotDate"],
                        row["actionDate"],
                        row["terminalDate"],
                        row["snapshotPrice"],
                        row["actionOpen"],
                        row["terminalClose"],
                        row["actionCapacityShares"],
                        fills["ADD"],
                        fills["REDUCE"],
                        fills["EXIT"],
                        values["HOLD"],
                        values["ADD"],
                        values["REDUCE"],
                        values["EXIT"],
                        deltas["ADD"],
                        deltas["REDUCE"],
                        deltas["EXIT"],
                        row["bestAction"],
                        canonical_sha256(row),
                    )
                )
            self.db.executemany(
                "INSERT INTO position_action_labels VALUES "
                f"({','.join('?' for _ in range(24))})",
                records,
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return {
            "decisionDate": decision_date,
            "status": "COMPLETED",
            "fullFillScenarios": len(labels),
            "labels": len(labels),
        }

    def seal(self) -> dict:
        expected = self.source.execute(
            "SELECT COUNT(*) FROM label_partitions"
        ).fetchone()[0]
        completed = self.db.execute(
            "SELECT COUNT(*) FROM position_action_partitions"
        ).fetchone()[0]
        if completed != expected:
            raise PositionActionDatasetError("POSITION_ACTION_PARTITIONS_INCOMPLETE")
        metadata = dict(
            self.db.execute("SELECT * FROM position_action_metadata").fetchone()
        )
        labels = self.db.execute(
            "SELECT COUNT(*) FROM position_action_labels"
        ).fetchone()[0]
        best_actions = {
            row["best_action"]: row["count"]
            for row in self.db.execute(
                "SELECT best_action,COUNT(*) AS count FROM position_action_labels "
                "GROUP BY best_action"
            )
        }
        boards = {
            row["board"]: row["count"]
            for row in self.db.execute(
                "SELECT board,COUNT(*) AS count FROM position_action_labels "
                "GROUP BY board"
            )
        }
        self.db.commit()
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        manifest = {
            "datasetId": metadata["dataset_id"],
            "schemaVersion": metadata["schema_version"],
            "createdAt": metadata["created_at"],
            "sealedAt": _now(),
            "database": self.database_path.name,
            "databaseSha256": _file_sha256(self.database_path),
            "episodeDatasetId": metadata["episode_dataset_id"],
            "episodeDatabaseSha256": metadata["episode_database_sha256"],
            "labelDatasetId": metadata["label_dataset_id"],
            "labelDatabaseSha256": metadata["label_database_sha256"],
            "marketDatabaseSha256": metadata["market_database_sha256"],
            "policySha256": metadata["policy_sha256"],
            "partitions": completed,
            "labels": labels,
            "bestActions": best_actions,
            "labelsByBoard": boards,
        }
        temporary = self.manifest_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2)
            + "\n"
        )
        os.replace(temporary, self.manifest_path)
        return manifest
