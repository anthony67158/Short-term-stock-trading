"""Resumable point-in-time market-cap data for foundation-model sampling."""

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import sqlite3
import time
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from platform_app.adapters.market_tushare import HistoricalMarketError, TushareClient
from platform_app.modules.experiments.episode_dataset import (
    canonical_json,
    canonical_sha256,
)
from platform_app.modules.experiments.foundation_return_dataset import (
    FoundationReturnDatasetError,
    verify_foundation_return_dataset,
)

SCHEMA_VERSION = "foundation-market-cap-dataset.v1"
SOURCE_FIELDS = (
    "ts_code,trade_date,close,total_share,float_share,total_mv,circ_mv"
)
UNIT_MULTIPLIER = Decimal("10000")
POLICY = {
    "policyVersion": "foundation-market-cap-ingestion.v1",
    "sourceApi": "TUSHARE_COMPATIBLE.daily_basic",
    "sourceFields": SOURCE_FIELDS.split(","),
    "totalSharesUnit": "SHARES",
    "floatSharesUnit": "SHARES",
    "marketCapUnit": "CNY",
    "sourceUnitMultiplier": "10000",
    "effectiveAt": "SESSION_CLOSE_15_00_ASIA_SHANGHAI",
    "publishedAt": "CONSERVATIVE_18_00_ASIA_SHANGHAI_ASSUMPTION",
    "asOf": "PUBLISHED_AT",
    "coverage": "EVERY_FOUNDATION_REFERENCE_SAMPLE",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS market_cap_dataset_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    dataset_id TEXT NOT NULL UNIQUE,
    schema_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    foundation_dataset_id TEXT NOT NULL,
    foundation_database_sha256 TEXT NOT NULL,
    ranking_dataset_id TEXT NOT NULL,
    ranking_database_sha256 TEXT NOT NULL,
    market_dataset_id TEXT NOT NULL,
    market_database_sha256 TEXT NOT NULL,
    policy_sha256 TEXT NOT NULL,
    policy_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS market_cap_partitions (
    decision_date TEXT PRIMARY KEY,
    expected_count INTEGER NOT NULL CHECK (expected_count > 0),
    source_count INTEGER NOT NULL CHECK (source_count >= expected_count),
    accepted_count INTEGER NOT NULL CHECK (accepted_count = expected_count),
    payload_sha256 TEXT NOT NULL,
    completed_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS market_cap_rows (
    decision_date TEXT NOT NULL REFERENCES market_cap_partitions(decision_date),
    instrument_id TEXT NOT NULL,
    board TEXT NOT NULL CHECK (board IN ('MAIN', 'CHINEXT', 'STAR', 'BEIJING')),
    source_code TEXT NOT NULL,
    close TEXT NOT NULL,
    total_shares TEXT NOT NULL,
    float_shares TEXT NOT NULL,
    total_market_cap_cny TEXT NOT NULL,
    float_market_cap_cny TEXT NOT NULL,
    effective_at TEXT NOT NULL,
    published_at TEXT NOT NULL,
    as_of TEXT NOT NULL,
    availability_method TEXT NOT NULL,
    source_row_sha256 TEXT NOT NULL,
    PRIMARY KEY (instrument_id, decision_date)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS market_cap_rows_date_idx
ON market_cap_rows(decision_date, board);
"""


class FoundationMarketCapDatasetError(ValueError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _verified_upstream(root: Path, expected_schema: str) -> tuple[dict, Path]:
    resolved = root.expanduser().resolve()
    manifest_path = resolved / "manifest.json"
    if not manifest_path.is_file():
        raise FoundationMarketCapDatasetError("MARKET_CAP_UPSTREAM_NOT_SEALED")
    try:
        manifest = json.loads(manifest_path.read_text())
        database = resolved / manifest["database"]
        expected_hash = manifest["databaseSha256"]
    except (KeyError, json.JSONDecodeError, TypeError) as exc:
        raise FoundationMarketCapDatasetError(
            "MARKET_CAP_UPSTREAM_MANIFEST_INVALID",
        ) from exc
    if (
        manifest.get("schemaVersion") != expected_schema
        or re.fullmatch(r"[0-9a-f]{64}", str(expected_hash)) is None
        or not database.is_file()
        or _file_sha256(database) != expected_hash
    ):
        raise FoundationMarketCapDatasetError("MARKET_CAP_UPSTREAM_INVALID")
    return manifest, database


def verify_foundation_market_cap_dataset(root: Path) -> tuple[dict, Path]:
    resolved = root.expanduser().resolve()
    manifest_path = resolved / "market-cap-manifest.json"
    if not manifest_path.is_file():
        raise FoundationMarketCapDatasetError("MARKET_CAP_DATASET_NOT_SEALED")
    try:
        manifest = json.loads(manifest_path.read_text())
        database = resolved / manifest["database"]
        expected_hash = manifest["databaseSha256"]
    except (KeyError, json.JSONDecodeError, TypeError) as exc:
        raise FoundationMarketCapDatasetError(
            "MARKET_CAP_DATASET_MANIFEST_INVALID",
        ) from exc
    if (
        manifest.get("schemaVersion") != SCHEMA_VERSION
        or re.fullmatch(r"[0-9a-f]{64}", str(expected_hash)) is None
        or not database.is_file()
        or _file_sha256(database) != expected_hash
    ):
        raise FoundationMarketCapDatasetError("MARKET_CAP_DATASET_INVALID")
    return manifest, database


def _decimal(value, error: str) -> Decimal:
    try:
        result = Decimal(str(value))
    except Exception as exc:
        raise FoundationMarketCapDatasetError(error) from exc
    if not result.is_finite() or result <= 0:
        raise FoundationMarketCapDatasetError(error)
    return result


def _text(value: Decimal) -> str:
    rendered = format(value.normalize(), "f")
    return "0" if rendered in {"", "-0"} else rendered


def _market_cap_row(
    row: dict,
    *,
    instrument_id: str,
    board: str,
    decision_date: str,
) -> dict:
    if row.get("trade_date") != decision_date:
        raise FoundationMarketCapDatasetError(
            "MARKET_CAP_PARTITION_DATE_MISMATCH",
        )
    source_code = str(row.get("ts_code") or "").upper()
    if re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", source_code) is None:
        raise FoundationMarketCapDatasetError("MARKET_CAP_SOURCE_CODE_INVALID")
    close = _decimal(row.get("close"), "MARKET_CAP_CLOSE_INVALID")
    total_shares = _decimal(
        row.get("total_share"),
        "MARKET_CAP_TOTAL_SHARES_INVALID",
    ) * UNIT_MULTIPLIER
    float_shares = _decimal(
        row.get("float_share"),
        "MARKET_CAP_FLOAT_SHARES_INVALID",
    ) * UNIT_MULTIPLIER
    total_market_cap = _decimal(
        row.get("total_mv"),
        "MARKET_CAP_TOTAL_VALUE_INVALID",
    ) * UNIT_MULTIPLIER
    float_market_cap = _decimal(
        row.get("circ_mv"),
        "MARKET_CAP_FLOAT_VALUE_INVALID",
    ) * UNIT_MULTIPLIER
    if float_shares > total_shares or float_market_cap > total_market_cap:
        raise FoundationMarketCapDatasetError(
            "MARKET_CAP_FLOAT_EXCEEDS_TOTAL",
        )
    expected_total = close * total_shares
    expected_float = close * float_shares
    for expected, actual in (
        (expected_total, total_market_cap),
        (expected_float, float_market_cap),
    ):
        if abs(expected - actual) / actual > Decimal("0.001"):
            raise FoundationMarketCapDatasetError(
                "MARKET_CAP_VALUE_RECONCILIATION_FAILED",
            )
    date = (
        f"{decision_date[:4]}-{decision_date[4:6]}-{decision_date[6:]}"
    )
    published_at = f"{date}T18:00:00+08:00"
    source = {
        name: row.get(name)
        for name in SOURCE_FIELDS.split(",")
    }
    return {
        "decisionDate": decision_date,
        "instrumentId": instrument_id,
        "board": board,
        "sourceCode": source_code,
        "close": _text(close),
        "totalShares": _text(total_shares),
        "floatShares": _text(float_shares),
        "totalMarketCapCny": _text(total_market_cap),
        "floatMarketCapCny": _text(float_market_cap),
        "effectiveAt": f"{date}T15:00:00+08:00",
        "publishedAt": published_at,
        "asOf": published_at,
        "availabilityMethod": "CONSERVATIVE_SESSION_CLOSE_ASSUMPTION",
        "sourceRowSha256": canonical_sha256(source),
    }


class FoundationMarketCapDataset:
    def __init__(
        self,
        root: Path,
        *,
        dataset_id: str,
        foundation_dataset_root: Path,
        ranking_dataset_root: Path,
        market_dataset_root: Path,
    ):
        self.root = root.expanduser().resolve()
        self.database_path = self.root / "market-cap.sqlite3"
        self.manifest_path = self.root / "market-cap-manifest.json"
        if self.manifest_path.exists():
            raise FoundationMarketCapDatasetError(
                "MARKET_CAP_DATASET_ALREADY_SEALED",
            )
        try:
            foundation, foundation_database = verify_foundation_return_dataset(
                foundation_dataset_root,
            )
        except FoundationReturnDatasetError as exc:
            raise FoundationMarketCapDatasetError(
                "MARKET_CAP_FOUNDATION_DATASET_INVALID",
            ) from exc
        ranking, self.ranking_database_path = _verified_upstream(
            ranking_dataset_root,
            "ranking-dataset.v1",
        )
        market, self.market_database_path = _verified_upstream(
            market_dataset_root,
            "market-dataset.v4",
        )
        if (
            foundation["rankingDataset"]["databaseSha256"]
            != ranking["databaseSha256"]
            or foundation["marketDataset"]["databaseSha256"]
            != market["databaseSha256"]
            or ranking.get("marketDatabaseSha256") != market["databaseSha256"]
        ):
            raise FoundationMarketCapDatasetError(
                "MARKET_CAP_UPSTREAM_LINEAGE_MISMATCH",
            )
        policy_json = canonical_json(POLICY)
        policy_hash = hashlib.sha256(policy_json.encode()).hexdigest()
        identity = (
            dataset_id,
            SCHEMA_VERSION,
            foundation["datasetId"],
            _file_sha256(foundation_database),
            ranking["datasetId"],
            ranking["databaseSha256"],
            market["datasetId"],
            market["databaseSha256"],
            policy_hash,
            policy_json,
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
            "foundation_database_sha256, ranking_dataset_id, "
            "ranking_database_sha256, market_dataset_id, market_database_sha256, "
            "policy_sha256, policy_json FROM market_cap_dataset_metadata",
        ).fetchone()
        if existing and tuple(existing) != identity:
            self.close()
            raise FoundationMarketCapDatasetError(
                "MARKET_CAP_DATASET_IDENTITY_MISMATCH",
            )
        if not existing:
            self.db.execute(
                "INSERT INTO market_cap_dataset_metadata VALUES "
                "(1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (dataset_id, SCHEMA_VERSION, _now(), *identity[2:]),
            )
            self.db.commit()
        self.ranking = self._open_readonly(self.ranking_database_path)
        self.market = self._open_readonly(self.market_database_path)

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
        self.market.close()
        self.ranking.close()
        self.db.close()

    def pending_dates(self) -> list[str]:
        completed = {
            row["decision_date"]
            for row in self.db.execute(
                "SELECT decision_date FROM market_cap_partitions",
            )
        }
        return [
            row["decision_date"]
            for row in self.ranking.execute(
                "SELECT DISTINCT decision_date FROM ranking_samples "
                "ORDER BY decision_date",
            )
            if row["decision_date"] not in completed
        ]

    def _source_code_map(self, decision_date: str) -> dict[str, str]:
        current_by_instrument = {
            row["instrument_id"]: row["source_code"]
            for row in self.market.execute(
                "SELECT source_code, instrument_id FROM instruments",
            )
        }
        active_aliases: dict[str, str] = {}
        for row in self.market.execute(
            "SELECT source_code, instrument_id FROM instrument_aliases "
            "WHERE effective_from <= ? "
            "AND (effective_to IS NULL OR effective_to > ?)",
            (decision_date, decision_date),
        ):
            instrument_id = row["instrument_id"]
            if instrument_id in active_aliases:
                raise FoundationMarketCapDatasetError(
                    "MARKET_CAP_ACTIVE_ALIAS_DUPLICATE",
                )
            active_aliases[instrument_id] = row["source_code"]
        active_by_instrument = {
            instrument_id: active_aliases.get(instrument_id, source_code)
            for instrument_id, source_code in current_by_instrument.items()
        }
        if len(set(active_by_instrument.values())) != len(active_by_instrument):
            raise FoundationMarketCapDatasetError(
                "MARKET_CAP_ACTIVE_SOURCE_CODE_DUPLICATE",
            )
        return {
            source_code: instrument_id
            for instrument_id, source_code in active_by_instrument.items()
        }

    def ingest_partition(self, decision_date: str, source_rows: list[dict]) -> dict:
        if re.fullmatch(r"\d{8}", decision_date) is None:
            raise FoundationMarketCapDatasetError(
                "MARKET_CAP_PARTITION_DATE_INVALID",
            )
        existing = self.db.execute(
            "SELECT expected_count, source_count, accepted_count "
            "FROM market_cap_partitions WHERE decision_date = ?",
            (decision_date,),
        ).fetchone()
        if existing:
            return {
                "decisionDate": decision_date,
                "status": "SKIPPED",
                "expectedCount": existing["expected_count"],
                "sourceCount": existing["source_count"],
                "acceptedCount": existing["accepted_count"],
            }
        expected = {
            row["instrument_id"]: row["board"]
            for row in self.ranking.execute(
                "SELECT instrument_id, board FROM ranking_samples "
                "WHERE decision_date = ?",
                (decision_date,),
            )
        }
        if not expected:
            raise FoundationMarketCapDatasetError(
                "MARKET_CAP_PARTITION_NOT_IN_FOUNDATION_DATASET",
            )
        source_codes = self._source_code_map(decision_date)
        accepted = {}
        seen_source_codes = set()
        for source_row in source_rows:
            source_code = str(source_row.get("ts_code") or "").upper()
            if source_code in seen_source_codes:
                raise FoundationMarketCapDatasetError(
                    "MARKET_CAP_SOURCE_DUPLICATE",
                )
            seen_source_codes.add(source_code)
            instrument_id = source_codes.get(source_code)
            if instrument_id not in expected:
                continue
            if instrument_id in accepted:
                raise FoundationMarketCapDatasetError(
                    "MARKET_CAP_INSTRUMENT_DUPLICATE",
                )
            accepted[instrument_id] = _market_cap_row(
                source_row,
                instrument_id=instrument_id,
                board=expected[instrument_id],
                decision_date=decision_date,
            )
        missing = sorted(set(expected) - set(accepted))
        if missing:
            raise FoundationMarketCapDatasetError(
                f"MARKET_CAP_PARTITION_COVERAGE_INCOMPLETE:{len(missing)}",
            )
        normalized = [accepted[key] for key in sorted(accepted)]
        payload_hash = canonical_sha256(normalized)
        try:
            self.db.execute(
                "INSERT INTO market_cap_partitions VALUES (?, ?, ?, ?, ?, ?)",
                (
                    decision_date,
                    len(expected),
                    len(source_rows),
                    len(normalized),
                    payload_hash,
                    _now(),
                ),
            )
            self.db.executemany(
                "INSERT INTO market_cap_rows VALUES "
                f"({','.join('?' for _ in range(14))})",
                [
                    (
                        row["decisionDate"],
                        row["instrumentId"],
                        row["board"],
                        row["sourceCode"],
                        row["close"],
                        row["totalShares"],
                        row["floatShares"],
                        row["totalMarketCapCny"],
                        row["floatMarketCapCny"],
                        row["effectiveAt"],
                        row["publishedAt"],
                        row["asOf"],
                        row["availabilityMethod"],
                        row["sourceRowSha256"],
                    )
                    for row in normalized
                ],
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return {
            "decisionDate": decision_date,
            "status": "COMPLETED",
            "expectedCount": len(expected),
            "sourceCount": len(source_rows),
            "acceptedCount": len(normalized),
            "payloadSha256": payload_hash,
        }

    def fetch_partition(
        self,
        decision_date: str,
        client: TushareClient,
        *,
        maximum_attempts: int = 5,
    ) -> dict:
        rows = self.fetch_source_rows(
            decision_date,
            client,
            maximum_attempts=maximum_attempts,
        )
        return self.ingest_partition(decision_date, rows)

    @staticmethod
    def fetch_source_rows(
        decision_date: str,
        client: TushareClient,
        *,
        maximum_attempts: int = 5,
    ) -> list[dict]:
        retryable = {
            "MARKET_DATA_RATE_LIMITED",
            "MARKET_DATA_UPSTREAM_FAILED",
        }
        for attempt in range(1, maximum_attempts + 1):
            try:
                rows = client.rows(
                    "daily_basic",
                    {"trade_date": decision_date},
                    SOURCE_FIELDS,
                )
                return rows
            except HistoricalMarketError as exc:
                if str(exc) not in retryable or attempt == maximum_attempts:
                    raise
                time.sleep(min(60, 2**attempt))
        raise AssertionError("unreachable")

    def build(
        self,
        client: TushareClient,
        *,
        maximum_partitions: int | None = None,
        workers: int = 1,
    ):
        pending = self.pending_dates()
        if maximum_partitions is not None:
            if maximum_partitions <= 0:
                raise FoundationMarketCapDatasetError(
                    "MARKET_CAP_MAXIMUM_PARTITIONS_INVALID",
                )
            pending = pending[:maximum_partitions]
        if workers < 1 or workers > 8:
            raise FoundationMarketCapDatasetError(
                "MARKET_CAP_WORKER_COUNT_INVALID",
            )
        if workers == 1:
            for decision_date in pending:
                yield self.fetch_partition(decision_date, client)
            return

        pending_iterator = iter(pending)
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=workers,
            thread_name_prefix="foundation-market-cap",
        ) as executor:
            active = {}
            for _ in range(workers):
                decision_date = next(pending_iterator, None)
                if decision_date is None:
                    break
                future = executor.submit(
                    self.fetch_source_rows,
                    decision_date,
                    client,
                )
                active[future] = decision_date
            while active:
                done, _pending = concurrent.futures.wait(
                    active,
                    return_when=concurrent.futures.FIRST_COMPLETED,
                )
                for future in done:
                    decision_date = active.pop(future)
                    yield self.ingest_partition(decision_date, future.result())
                    next_date = next(pending_iterator, None)
                    if next_date is not None:
                        next_future = executor.submit(
                            self.fetch_source_rows,
                            next_date,
                            client,
                        )
                        active[next_future] = next_date

    def seal(self) -> dict:
        expected_partitions = self.ranking.execute(
            "SELECT COUNT(DISTINCT decision_date) FROM ranking_samples",
        ).fetchone()[0]
        expected_rows = self.ranking.execute(
            "SELECT COUNT(*) FROM ranking_samples",
        ).fetchone()[0]
        completed_partitions = self.db.execute(
            "SELECT COUNT(*) FROM market_cap_partitions",
        ).fetchone()[0]
        completed_rows = self.db.execute(
            "SELECT COUNT(*) FROM market_cap_rows",
        ).fetchone()[0]
        if completed_partitions != expected_partitions:
            raise FoundationMarketCapDatasetError(
                "MARKET_CAP_PARTITIONS_INCOMPLETE",
            )
        if completed_rows != expected_rows:
            raise FoundationMarketCapDatasetError("MARKET_CAP_ROWS_INCOMPLETE")
        coverage_mismatch = self.db.execute(
            "SELECT COUNT(*) FROM market_cap_partitions "
            "WHERE expected_count != accepted_count",
        ).fetchone()[0]
        if coverage_mismatch:
            raise FoundationMarketCapDatasetError(
                "MARKET_CAP_COVERAGE_MISMATCH",
            )
        metadata = dict(
            self.db.execute("SELECT * FROM market_cap_dataset_metadata").fetchone()
        )
        bounds = dict(
            self.db.execute(
                "SELECT MIN(decision_date) AS start_date, "
                "MAX(decision_date) AS end_date FROM market_cap_partitions",
            ).fetchone()
        )
        boards = {
            row["board"]: row["count"]
            for row in self.db.execute(
                "SELECT board, COUNT(*) AS count FROM market_cap_rows GROUP BY board",
            )
        }
        self.db.commit()
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        if self.db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise FoundationMarketCapDatasetError(
                "MARKET_CAP_DATASET_INTEGRITY_FAILED",
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
            "rankingDatasetId": metadata["ranking_dataset_id"],
            "rankingDatabaseSha256": metadata["ranking_database_sha256"],
            "marketDatasetId": metadata["market_dataset_id"],
            "marketDatabaseSha256": metadata["market_database_sha256"],
            "policySha256": metadata["policy_sha256"],
            "partitions": completed_partitions,
            "rows": completed_rows,
            "rowsByBoard": boards,
            "startDate": bounds["start_date"],
            "endDate": bounds["end_date"],
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
    parser.add_argument("--market-root", type=Path, required=True)
    parser.add_argument("--maximum-partitions", type=int)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--seal", action="store_true")
    args = parser.parse_args()
    with FoundationMarketCapDataset(
        args.root,
        dataset_id=args.dataset_id,
        foundation_dataset_root=args.foundation_root,
        ranking_dataset_root=args.ranking_root,
        market_dataset_root=args.market_root,
    ) as dataset:
        for result in dataset.build(
            TushareClient(),
            maximum_partitions=args.maximum_partitions,
            workers=args.workers,
        ):
            print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)
        if args.seal:
            print(
                json.dumps(dataset.seal(), ensure_ascii=False, sort_keys=True),
                flush=True,
            )


if __name__ == "__main__":
    main()
