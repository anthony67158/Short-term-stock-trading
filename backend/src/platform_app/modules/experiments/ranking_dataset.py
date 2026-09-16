"""Resumable full-universe daily ranking dataset."""

import hashlib
import json
import os
import sqlite3
from bisect import bisect_left
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

from platform_app.modules.experiments.daily_ranking_sample import (
    FEATURE_SCHEMA_VERSION,
    HISTORY_SESSIONS,
    HORIZON_SESSIONS,
    OUTCOME_SCHEMA_VERSION,
    build_daily_ranking_sample,
)
from platform_app.modules.experiments.episode_dataset import (
    BOARDS,
    canonical_json,
    verify_market_dataset,
)

SCHEMA_VERSION = "ranking-dataset.v1"
RANKING_POLICY = {
    "policyVersion": "full-universe-daily-ranking.v1",
    "universe": "ALL_POINT_IN_TIME_LISTED_A_SHARES",
    "historySessions": HISTORY_SESSIONS,
    "horizonSessions": HORIZON_SESSIONS,
    "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
    "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
    "entryReference": "NEXT_SESSION_RAW_OPEN",
    "terminalReference": "FIFTH_SESSION_RAW_CLOSE",
    "returnAdjustment": "POINT_IN_TIME_ADJUSTMENT_FACTOR",
    "purpose": "CROSS_SECTIONAL_RANKING_NOT_EXECUTION_PNL",
}

FEATURE_COLUMNS = (
    "adjustedReturn1",
    "adjustedReturn5",
    "adjustedReturn10",
    "adjustedReturn20",
    "adjustedReturn60",
    "realizedVolatility5",
    "realizedVolatility20",
    "realizedVolatility60",
    "drawdownFromHigh20",
    "distanceFromLow20",
    "medianAmount5Cny",
    "medianAmount20Cny",
    "medianAmount60Cny",
    "amountToMedian20",
    "meanRange20",
    "gap1",
    "closeLocation1",
    "listingAgeDays",
)
OUTCOME_COLUMNS = (
    "forwardReturnDecisionClose5",
    "forwardReturnNextOpen5",
    "maximumAdverseExcursion5",
    "maximumFavorableExcursion5",
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS ranking_dataset_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    dataset_id TEXT NOT NULL UNIQUE,
    schema_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    market_dataset_id TEXT NOT NULL,
    market_schema_version TEXT NOT NULL,
    market_database_sha256 TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    policy_sha256 TEXT NOT NULL,
    policy_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS ranking_samples (
    instrument_id TEXT NOT NULL,
    decision_date TEXT NOT NULL,
    board TEXT NOT NULL CHECK (board IN ('MAIN', 'CHINEXT', 'STAR', 'BEIJING')),
    execution_date TEXT NOT NULL,
    terminal_date TEXT NOT NULL,
    feature_available_at TEXT NOT NULL,
    adjusted_return_1 TEXT NOT NULL,
    adjusted_return_5 TEXT NOT NULL,
    adjusted_return_10 TEXT NOT NULL,
    adjusted_return_20 TEXT NOT NULL,
    adjusted_return_60 TEXT NOT NULL,
    realized_volatility_5 TEXT NOT NULL,
    realized_volatility_20 TEXT NOT NULL,
    realized_volatility_60 TEXT NOT NULL,
    drawdown_from_high_20 TEXT NOT NULL,
    distance_from_low_20 TEXT NOT NULL,
    median_amount_5_cny TEXT NOT NULL,
    median_amount_20_cny TEXT NOT NULL,
    median_amount_60_cny TEXT NOT NULL,
    amount_to_median_20 TEXT NOT NULL,
    mean_range_20 TEXT NOT NULL,
    gap_1 TEXT NOT NULL,
    close_location_1 TEXT NOT NULL,
    listing_age_days INTEGER NOT NULL,
    forward_return_decision_close_5 TEXT NOT NULL,
    forward_return_next_open_5 TEXT NOT NULL,
    maximum_adverse_excursion_5 TEXT NOT NULL,
    maximum_favorable_excursion_5 TEXT NOT NULL,
    PRIMARY KEY (instrument_id, decision_date)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ranking_instrument_progress (
    instrument_id TEXT PRIMARY KEY,
    board TEXT NOT NULL,
    universe_date_count INTEGER NOT NULL CHECK (universe_date_count >= 0),
    sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
    rejection_counts_json TEXT NOT NULL,
    completed_at TEXT NOT NULL
) STRICT;
"""


class RankingDatasetError(ValueError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class RankingDataset:
    def __init__(
        self,
        root: Path,
        *,
        dataset_id: str,
        market_dataset_root: Path,
        start_date: str,
        end_date: str,
    ):
        self.root = root.resolve()
        self.database_path = self.root / "ranking.sqlite3"
        self.manifest_path = self.root / "manifest.json"
        if self.manifest_path.exists():
            raise RankingDatasetError("RANKING_DATASET_ALREADY_SEALED")
        if start_date > end_date:
            raise RankingDatasetError("RANKING_DATE_RANGE_INVALID")
        market = verify_market_dataset(market_dataset_root)
        policy_json = canonical_json(RANKING_POLICY)
        policy_hash = hashlib.sha256(policy_json.encode()).hexdigest()
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.database_path, autocommit=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        identity = (
            dataset_id,
            SCHEMA_VERSION,
            market["datasetId"],
            market["schemaVersion"],
            market["databaseSha256"],
            start_date,
            end_date,
            policy_hash,
            policy_json,
        )
        existing = self.db.execute(
            "SELECT dataset_id, schema_version, market_dataset_id, "
            "market_schema_version, market_database_sha256, start_date, end_date, "
            "policy_sha256, policy_json FROM ranking_dataset_metadata"
        ).fetchone()
        if existing and tuple(existing) != identity:
            self.close()
            raise RankingDatasetError("RANKING_DATASET_IDENTITY_MISMATCH")
        if not existing:
            self.db.execute(
                "INSERT INTO ranking_dataset_metadata VALUES "
                "(1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (dataset_id, SCHEMA_VERSION, _now(), *identity[2:]),
            )
            self.db.commit()
        self.start_date = start_date
        self.end_date = end_date
        market_uri = f"{market['database'].resolve().as_uri()}?mode=ro&immutable=1"
        self.market = sqlite3.connect(market_uri, uri=True)
        self.market.row_factory = sqlite3.Row
        self.open_dates = [
            row["cal_date"]
            for row in self.market.execute(
                "SELECT cal_date FROM trade_calendar "
                "WHERE exchange = 'SSE' AND is_open = 1 ORDER BY cal_date"
            )
        ]
        self.date_indexes = {
            trade_date: index for index, trade_date in enumerate(self.open_dates)
        }
        self.requested_dates = [
            value for value in self.open_dates if start_date <= value <= end_date
        ]

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()

    def close(self) -> None:
        self.market.close()
        self.db.close()

    def build(self, max_instruments: int | None = None):
        completed = {
            row["instrument_id"]
            for row in self.db.execute(
                "SELECT instrument_id FROM ranking_instrument_progress"
            )
        }
        instruments = self.market.execute(
            "SELECT instrument_id, board, list_date, delist_date "
            "FROM instruments ORDER BY instrument_id"
        )
        processed = 0
        for instrument in instruments:
            if instrument["instrument_id"] in completed:
                continue
            if max_instruments is not None and processed >= max_instruments:
                break
            yield self.build_instrument(dict(instrument))
            processed += 1

    def build_instrument(self, instrument: dict) -> dict:
        instrument_id = instrument["instrument_id"]
        board = instrument["board"]
        if board not in BOARDS:
            raise RankingDatasetError("RANKING_UNSUPPORTED_BOARD")
        if self.db.execute(
            "SELECT 1 FROM ranking_instrument_progress WHERE instrument_id = ?",
            (instrument_id,),
        ).fetchone():
            return {"instrumentId": instrument_id, "status": "SKIPPED"}

        start = bisect_left(
            self.requested_dates,
            max(self.start_date, instrument["list_date"]),
        )
        end = (
            len(self.requested_dates)
            if instrument["delist_date"] is None
            else bisect_left(self.requested_dates, instrument["delist_date"])
        )
        universe_dates = self.requested_dates[start:end]
        market_rows = {
            row["trade_date"]: dict(row)
            for row in self.market.execute(
                "SELECT d.trade_date, d.open, d.high, d.low, d.close, "
                "d.previous_close, d.amount_cny, d.available_at AS daily_available_at, "
                "a.factor, a.available_at AS factor_available_at "
                "FROM daily_bars d LEFT JOIN adjustment_factors a "
                "ON a.instrument_id = d.instrument_id AND a.trade_date = d.trade_date "
                "WHERE d.instrument_id = ? ORDER BY d.trade_date",
                (instrument_id,),
            )
        }
        suspended = {
            row["trade_date"]
            for row in self.market.execute(
                "SELECT DISTINCT trade_date FROM suspensions WHERE instrument_id = ?",
                (instrument_id,),
            )
        }
        listing_suspended = [
            (row["effective_from"], row["effective_to"])
            for row in self.market.execute(
                "SELECT effective_from, effective_to FROM listing_status_periods "
                "WHERE instrument_id = ?",
                (instrument_id,),
            )
        ]
        list_date = datetime.strptime(instrument["list_date"], "%Y%m%d").date()
        samples = []
        rejections: Counter[str] = Counter()
        for decision_date in universe_dates:
            decision_index = self.date_indexes[decision_date]
            reason = None
            if any(start <= decision_date < end for start, end in listing_suspended):
                reason = "LISTING_SUSPENDED"
            elif decision_date in suspended:
                reason = "SUSPENDED"
            elif decision_index < HISTORY_SESSIONS - 1:
                reason = "INSUFFICIENT_DATASET_HISTORY"
            elif decision_index + HORIZON_SESSIONS >= len(self.open_dates):
                reason = "HORIZON_INCOMPLETE"
            else:
                history_dates = self.open_dates[
                    decision_index - HISTORY_SESSIONS + 1 : decision_index + 1
                ]
                future_dates = self.open_dates[
                    decision_index + 1 : decision_index + HORIZON_SESSIONS + 1
                ]
                history = [market_rows.get(value) for value in history_dates]
                future = [market_rows.get(value) for value in future_dates]
                if any(row is None for row in history):
                    reason = "HISTORY_PATH_UNAVAILABLE"
                elif any(row is None for row in future):
                    reason = "FUTURE_PATH_UNAVAILABLE"
                elif any(row["factor"] is None for row in [*history, *future]):
                    reason = "ADJUSTMENT_FACTOR_UNAVAILABLE"
            if reason:
                rejections[reason] += 1
                continue
            try:
                sample = build_daily_ranking_sample(
                    history=history,
                    future=future,
                    listing_age_days=(
                        datetime.strptime(decision_date, "%Y%m%d").date() - list_date
                    ).days
                    + 1,
                )
            except ValueError as exc:
                rejections[str(exc)] += 1
                continue
            samples.append(
                (
                    instrument_id,
                    decision_date,
                    board,
                    future_dates[0],
                    future_dates[-1],
                    sample["featureAvailableAt"],
                    *(sample["features"][name] for name in FEATURE_COLUMNS),
                    *(sample["outcomes"][name] for name in OUTCOME_COLUMNS),
                )
            )

        try:
            self.db.executemany(
                "INSERT INTO ranking_samples VALUES "
                f"({','.join('?' for _ in range(28))})",
                samples,
            )
            self.db.execute(
                "INSERT INTO ranking_instrument_progress VALUES (?, ?, ?, ?, ?, ?)",
                (
                    instrument_id,
                    board,
                    len(universe_dates),
                    len(samples),
                    canonical_json(dict(sorted(rejections.items()))),
                    _now(),
                ),
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return {
            "instrumentId": instrument_id,
            "board": board,
            "status": "COMPLETED",
            "universeDates": len(universe_dates),
            "samples": len(samples),
            "rejections": dict(sorted(rejections.items())),
        }

    def seal(self) -> dict:
        expected = self.market.execute("SELECT COUNT(*) FROM instruments").fetchone()[0]
        completed = self.db.execute(
            "SELECT COUNT(*) FROM ranking_instrument_progress"
        ).fetchone()[0]
        if completed != expected:
            raise RankingDatasetError("RANKING_INSTRUMENTS_INCOMPLETE")
        self.db.execute(
            "CREATE INDEX IF NOT EXISTS ranking_samples_decision_idx "
            "ON ranking_samples(decision_date, board)"
        )
        metadata = dict(self.db.execute("SELECT * FROM ranking_dataset_metadata").fetchone())
        progress = self.db.execute(
            "SELECT universe_date_count, sample_count, rejection_counts_json "
            "FROM ranking_instrument_progress"
        ).fetchall()
        rejections: Counter[str] = Counter()
        for row in progress:
            rejections.update(json.loads(row["rejection_counts_json"]))
        board_counts = {
            row["board"]: row["count"]
            for row in self.db.execute(
                "SELECT board, COUNT(*) AS count FROM ranking_samples GROUP BY board"
            )
        }
        universe_dates = sum(row["universe_date_count"] for row in progress)
        sample_count = sum(row["sample_count"] for row in progress)
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
            "marketDatasetId": metadata["market_dataset_id"],
            "marketSchemaVersion": metadata["market_schema_version"],
            "marketDatabaseSha256": metadata["market_database_sha256"],
            "policySha256": metadata["policy_sha256"],
            "startDate": metadata["start_date"],
            "endDate": metadata["end_date"],
            "instruments": completed,
            "universeStockDates": universe_dates,
            "samples": sample_count,
            "samplesByBoard": board_counts,
            "unavailableByReason": dict(sorted(rejections.items())),
        }
        temporary = self.manifest_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        )
        os.replace(temporary, self.manifest_path)
        return manifest
