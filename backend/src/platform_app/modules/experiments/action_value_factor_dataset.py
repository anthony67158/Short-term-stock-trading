"""Sealed point-in-time six-factor features for action-value episodes."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from platform_app.adapters.market_tushare import TushareClient
from platform_app.modules.experiments.episode_dataset import canonical_sha256
from platform_app.modules.experiments.multifactor_features import (
    FACTOR_FAMILIES,
    FEATURE_SCHEMA_VERSION,
    METRIC_NAMES,
    build_multifactor_metrics,
    score_multifactor_cross_section,
)
from platform_app.modules.experiments.multifactor_source import (
    audit_multifactor_source_archive,
    build_multifactor_source_archive,
    dividend_continuity_as_of,
    financial_metric_snapshots_for_dates,
    financial_periods_for_dates,
    industry_members_as_of,
    read_source_partition,
    source_rows,
)


SCHEMA_VERSION = "action-value-factor-dataset.v2"
FEATURE_NAMES = tuple(
    [f"factorScore_{family}" for family in FACTOR_FAMILIES]
    + [f"metricScore_{metric}" for metric in METRIC_NAMES]
    + [f"factorMissing_{family}" for family in FACTOR_FAMILIES]
    + [f"metricMissing_{metric}" for metric in METRIC_NAMES]
)
POLICY = {
    "policyVersion": "action-value-six-factor.v1",
    "decisionAsOf": "21:00_ASIA_SHANGHAI",
    "dailyBasicAsOf": "SAME_SESSION_CLOSE_PUBLISHED_BY_18:00",
    "financialAsOf": "FINAL_ANNOUNCEMENT_DATE_LTE_DECISION_DATE",
    "dividendAsOf": "EX_DATE_LTE_DECISION_DATE",
    "crossSection": "FULL_RANKING_UNIVERSE_THEN_SELECT_EPISODES",
    "missingValue": "NEUTRAL_0.5_WITH_EXPLICIT_FAMILY_FLAG",
    "minimumReadyCoverage": 0.95,
    "minimumDailyReadyCoverage": 0.90,
}
SCORE_COLUMNS = (
    "value_score",
    "quality_score",
    "growth_score",
    "momentum_score",
    "dividend_score",
    "low_volatility_score",
)
SCHEMA = """
CREATE TABLE IF NOT EXISTS factor_dataset_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    dataset_id TEXT NOT NULL UNIQUE,
    schema_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    source_archive_sha256 TEXT NOT NULL,
    episode_dataset_id TEXT NOT NULL,
    episode_database_sha256 TEXT NOT NULL,
    label_dataset_id TEXT NOT NULL,
    label_database_sha256 TEXT NOT NULL,
    ranking_dataset_id TEXT NOT NULL,
    ranking_database_sha256 TEXT NOT NULL,
    market_dataset_id TEXT NOT NULL,
    market_database_sha256 TEXT NOT NULL,
    feature_schema_version TEXT NOT NULL,
    policy_sha256 TEXT NOT NULL,
    policy_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS factor_partitions (
    decision_date TEXT PRIMARY KEY,
    expected_episode_count INTEGER NOT NULL CHECK (expected_episode_count > 0),
    full_universe_count INTEGER NOT NULL
        CHECK (full_universe_count >= expected_episode_count),
    accepted_count INTEGER NOT NULL CHECK (accepted_count = expected_episode_count),
    ready_count INTEGER NOT NULL CHECK (
        ready_count >= 0 AND ready_count <= accepted_count
    ),
    industry_count INTEGER NOT NULL CHECK (
        industry_count >= 0 AND industry_count <= full_universe_count
    ),
    payload_sha256 TEXT NOT NULL,
    completed_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS factor_rows (
    decision_date TEXT NOT NULL REFERENCES factor_partitions(decision_date),
    episode_id TEXT PRIMARY KEY,
    instrument_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('READY', 'OOD')),
    value_score REAL,
    quality_score REAL,
    growth_score REAL,
    momentum_score REAL,
    dividend_score REAL,
    low_volatility_score REAL,
    metric_scores_json TEXT NOT NULL,
    missing_families_json TEXT NOT NULL,
    report_period TEXT,
    report_available_at TEXT,
    as_of TEXT NOT NULL,
    source_row_sha256 TEXT NOT NULL,
    UNIQUE (decision_date, instrument_id)
) STRICT;
CREATE INDEX IF NOT EXISTS factor_rows_date_idx
ON factor_rows(decision_date, state);
"""


class ActionValueFactorDatasetError(ValueError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _verified_dataset(
    root: Path,
    *,
    schema_version: str,
    database_name: str,
) -> tuple[dict, Path]:
    resolved = root.expanduser().resolve()
    manifest_path = resolved / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text())
        database = resolved / manifest["database"]
        database_hash = manifest["databaseSha256"]
    except (OSError, KeyError, TypeError, ValueError) as exc:
        raise ActionValueFactorDatasetError(
            "ACTION_VALUE_FACTOR_UPSTREAM_INVALID"
        ) from exc
    if (
        manifest.get("schemaVersion") != schema_version
        or manifest.get("database") != database_name
        or re.fullmatch(r"[0-9a-f]{64}", str(database_hash)) is None
        or not database.is_file()
        or _file_sha256(database) != database_hash
    ):
        raise ActionValueFactorDatasetError(
            "ACTION_VALUE_FACTOR_UPSTREAM_INVALID"
        )
    return manifest, database


def _canonical_source_code(instrument_id: str) -> str:
    value = str(instrument_id or "").upper()
    if re.fullmatch(r"(SH|SZ|BJ)\.\d{6}", value) is None:
        raise ActionValueFactorDatasetError(
            "ACTION_VALUE_FACTOR_INSTRUMENT_INVALID"
        )
    return f"{value[3:]}.{value[:2]}"


def _canonical_aliases(market: sqlite3.Connection) -> dict[str, str]:
    aliases: dict[str, str] = {}

    def register(source_code, instrument_id):
        source = str(source_code or "").upper()
        canonical = _canonical_source_code(instrument_id)
        existing = aliases.get(source)
        if existing is not None and existing != canonical:
            raise ActionValueFactorDatasetError(
                "ACTION_VALUE_FACTOR_ALIAS_CONFLICT"
            )
        aliases[source] = canonical

    for row in market.execute(
        "SELECT source_code, instrument_id FROM instruments"
    ):
        register(row["source_code"], row["instrument_id"])
    for row in market.execute(
        "SELECT source_code, instrument_id FROM instrument_aliases"
    ):
        register(row["source_code"], row["instrument_id"])
    return aliases


def _dated_aliases(
    market: sqlite3.Connection,
    decision_date: str,
) -> dict[str, tuple[str, int]]:
    aliases = {
        row["source_code"]: (
            _canonical_source_code(row["instrument_id"]),
            1,
        )
        for row in market.execute(
            "SELECT source_code,instrument_id FROM instruments"
        )
    }
    for row in market.execute(
        "SELECT source_code,instrument_id FROM instrument_aliases "
        "WHERE effective_from<=? "
        "AND (effective_to IS NULL OR effective_to>?)",
        (decision_date, decision_date),
    ):
        source_code = row["source_code"]
        value = (_canonical_source_code(row["instrument_id"]), 0)
        existing = aliases.get(source_code)
        if existing is not None and existing[0] != value[0]:
            raise ActionValueFactorDatasetError(
                "ACTION_VALUE_FACTOR_ALIAS_CONFLICT"
            )
        aliases[source_code] = value
    return aliases


def _canonicalize_rows(rows: list[dict], aliases: dict[str, str]) -> list[dict]:
    result = []
    for row in rows:
        source_code = str(row.get("ts_code") or "").upper()
        canonical = aliases.get(source_code)
        if canonical is None:
            continue
        result.append({**row, "ts_code": canonical})
    return result


def _finite(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _verified_factor_manifest(root: Path) -> tuple[dict, Path]:
    resolved = root.expanduser().resolve()
    manifest_path = resolved / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text())
        database = resolved / manifest["database"]
        database_hash = manifest["databaseSha256"]
    except (OSError, KeyError, TypeError, ValueError) as exc:
        raise ActionValueFactorDatasetError(
            "ACTION_VALUE_FACTOR_DATASET_NOT_SEALED"
        ) from exc
    if (
        manifest.get("schemaVersion") != SCHEMA_VERSION
        or manifest.get("database") != "factors.sqlite3"
        or re.fullmatch(r"[0-9a-f]{64}", str(database_hash)) is None
        or not database.is_file()
        or _file_sha256(database) != database_hash
    ):
        raise ActionValueFactorDatasetError(
            "ACTION_VALUE_FACTOR_DATASET_INVALID"
        )
    connection = sqlite3.connect(
        f"{database.as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    try:
        metadata = dict(
            connection.execute(
                "SELECT * FROM factor_dataset_metadata"
            ).fetchone()
        )
        totals = dict(
            connection.execute(
                "SELECT COUNT(*) AS partitions,"
                "SUM(accepted_count) AS rows,SUM(ready_count) AS ready_rows,"
                "MIN(decision_date) AS start_date,"
                "MAX(decision_date) AS end_date "
                "FROM factor_partitions"
            ).fetchone()
        )
    except (sqlite3.DatabaseError, TypeError) as exc:
        raise ActionValueFactorDatasetError(
            "ACTION_VALUE_FACTOR_DATASET_INVALID"
        ) from exc
    finally:
        connection.close()
    expected = {
        "datasetId": metadata["dataset_id"],
        "schemaVersion": metadata["schema_version"],
        "databaseSha256": database_hash,
        "sourceArchiveSha256": metadata["source_archive_sha256"],
        "episodeDatasetId": metadata["episode_dataset_id"],
        "episodeDatabaseSha256": metadata["episode_database_sha256"],
        "labelDatasetId": metadata["label_dataset_id"],
        "labelDatabaseSha256": metadata["label_database_sha256"],
        "rankingDatasetId": metadata["ranking_dataset_id"],
        "rankingDatabaseSha256": metadata["ranking_database_sha256"],
        "marketDatasetId": metadata["market_dataset_id"],
        "marketDatabaseSha256": metadata["market_database_sha256"],
        "featureSchemaVersion": metadata["feature_schema_version"],
        "policySha256": metadata["policy_sha256"],
        "partitions": totals["partitions"],
        "rows": totals["rows"],
        "readyRows": totals["ready_rows"],
        "startDate": totals["start_date"],
        "endDate": totals["end_date"],
    }
    if any(manifest.get(key) != value for key, value in expected.items()):
        raise ActionValueFactorDatasetError(
            "ACTION_VALUE_FACTOR_MANIFEST_MISMATCH"
        )
    return manifest, database


def verify_action_value_factor_dataset(root: Path) -> tuple[dict, Path]:
    return _verified_factor_manifest(root)


def load_factor_vectors(
    root: Path,
) -> tuple[dict[str, tuple[float, ...]], dict]:
    manifest, database = verify_action_value_factor_dataset(root)
    result = {}
    connection = sqlite3.connect(
        f"{database.as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    try:
        for row in connection.execute(
            "SELECT episode_id,"
            + ",".join(SCORE_COLUMNS)
            + ",metric_scores_json"
            + " FROM factor_rows ORDER BY decision_date,episode_id"
        ):
            try:
                metric_scores = json.loads(row["metric_scores_json"])
            except (TypeError, ValueError) as exc:
                raise ActionValueFactorDatasetError(
                    "ACTION_VALUE_FACTOR_METRIC_SCORES_INVALID"
                ) from exc
            if set(metric_scores) != set(METRIC_NAMES):
                raise ActionValueFactorDatasetError(
                    "ACTION_VALUE_FACTOR_METRIC_SCORES_INVALID"
                )
            scores = [
                float(row[column]) if row[column] is not None else 0.5
                for column in SCORE_COLUMNS
            ]
            metric_values = [
                (
                    float(metric_scores[name])
                    if metric_scores[name] is not None
                    else 0.5
                )
                for name in METRIC_NAMES
            ]
            factor_missing = [
                1.0 if row[column] is None else 0.0
                for column in SCORE_COLUMNS
            ]
            metric_missing = [
                1.0 if metric_scores[name] is None else 0.0
                for name in METRIC_NAMES
            ]
            result[row["episode_id"]] = tuple(
                (*scores, *metric_values, *factor_missing, *metric_missing)
            )
    finally:
        connection.close()
    if len(result) != manifest["rows"]:
        raise ActionValueFactorDatasetError(
            "ACTION_VALUE_FACTOR_VECTOR_COVERAGE_INVALID"
        )
    return result, manifest


class ActionValueFactorDataset:
    def __init__(
        self,
        root: Path,
        *,
        dataset_id: str,
        source_root: Path,
        episode_dataset_root: Path,
        label_dataset_root: Path,
        ranking_dataset_root: Path,
        market_dataset_root: Path,
    ):
        self.root = root.expanduser().resolve()
        self.database_path = self.root / "factors.sqlite3"
        self.manifest_path = self.root / "manifest.json"
        if self.manifest_path.exists():
            raise ActionValueFactorDatasetError(
                "ACTION_VALUE_FACTOR_DATASET_ALREADY_SEALED"
            )
        episode, episode_database = _verified_dataset(
            episode_dataset_root,
            schema_version="episode-dataset.v4",
            database_name="episodes.sqlite3",
        )
        label, label_database = _verified_dataset(
            label_dataset_root,
            schema_version="label-dataset.v2",
            database_name="labels.sqlite3",
        )
        ranking, ranking_database = _verified_dataset(
            ranking_dataset_root,
            schema_version="ranking-dataset.v1",
            database_name="ranking.sqlite3",
        )
        market, market_database = _verified_dataset(
            market_dataset_root,
            schema_version="market-dataset.v4",
            database_name="market.sqlite3",
        )
        if (
            label.get("episodeDatabaseSha256") != episode["databaseSha256"]
            or
            episode.get("marketDatabaseSha256") != market["databaseSha256"]
            or ranking.get("marketDatabaseSha256") != market["databaseSha256"]
        ):
            raise ActionValueFactorDatasetError(
                "ACTION_VALUE_FACTOR_UPSTREAM_LINEAGE_MISMATCH"
            )
        self.episode = self._open_readonly(episode_database)
        self.label = self._open_readonly(label_database)
        self.ranking = self._open_readonly(ranking_database)
        self.market = self._open_readonly(market_database)
        self.aliases = _canonical_aliases(self.market)
        self.decision_dates = [
            row["decision_date"]
            for row in self.label.execute(
                "SELECT DISTINCT decision_date FROM episode_labels "
                "ORDER BY decision_date"
            )
        ]
        periods = financial_periods_for_dates(self.decision_dates)
        source_audit = audit_multifactor_source_archive(
            source_root,
            expected_decision_dates=self.decision_dates,
            expected_financial_periods=periods,
        )
        if source_audit["state"] != "READY":
            self.close()
            raise ActionValueFactorDatasetError(
                "ACTION_VALUE_FACTOR_SOURCE_NOT_READY"
            )
        self.source_root = source_root.expanduser().resolve()
        self.financial_snapshots = financial_metric_snapshots_for_dates(
            _canonicalize_rows(
                source_rows(self.source_root, "income_vip"),
                self.aliases,
            ),
            _canonicalize_rows(
                source_rows(self.source_root, "balancesheet_vip"),
                self.aliases,
            ),
            _canonicalize_rows(
                source_rows(self.source_root, "cashflow_vip"),
                self.aliases,
            ),
            self.decision_dates,
        )
        self.dividends = _canonicalize_rows(
            source_rows(self.source_root, "dividend"),
            self.aliases,
        )
        self.industries = _canonicalize_rows(
            source_rows(self.source_root, "index_member_all"),
            self.aliases,
        )
        policy_json = json.dumps(
            POLICY,
            sort_keys=True,
            separators=(",", ":"),
        )
        policy_hash = hashlib.sha256(policy_json.encode()).hexdigest()
        identity = (
            dataset_id,
            SCHEMA_VERSION,
            source_audit["contentSha256"],
            episode["datasetId"],
            episode["databaseSha256"],
            label["datasetId"],
            label["databaseSha256"],
            ranking["datasetId"],
            ranking["databaseSha256"],
            market["datasetId"],
            market["databaseSha256"],
            FEATURE_SCHEMA_VERSION,
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
            "SELECT dataset_id,schema_version,source_archive_sha256,"
            "episode_dataset_id,episode_database_sha256,"
            "label_dataset_id,label_database_sha256,ranking_dataset_id,"
            "ranking_database_sha256,market_dataset_id,market_database_sha256,"
            "feature_schema_version,policy_sha256,policy_json "
            "FROM factor_dataset_metadata"
        ).fetchone()
        if existing and tuple(existing) != identity:
            self.close()
            raise ActionValueFactorDatasetError(
                "ACTION_VALUE_FACTOR_DATASET_IDENTITY_MISMATCH"
            )
        if not existing:
            self.db.execute(
                "INSERT INTO factor_dataset_metadata VALUES "
                "(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (dataset_id, SCHEMA_VERSION, _now(), *identity[2:]),
            )
            self.db.commit()

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

    def close(self):
        for connection in ("market", "ranking", "label", "episode", "db"):
            value = getattr(self, connection, None)
            if value is not None:
                value.close()

    def pending_dates(self) -> list[str]:
        completed = {
            row["decision_date"]
            for row in self.db.execute(
                "SELECT decision_date FROM factor_partitions"
            )
        }
        return [
            decision_date
            for decision_date in self.decision_dates
            if decision_date not in completed
        ]

    def _daily_basics(self, decision_date: str) -> dict[str, dict]:
        basics = {}
        priorities = {}
        aliases = _dated_aliases(self.market, decision_date)
        for row in read_source_partition(
            self.source_root,
            "daily_basic",
            decision_date,
        ):
            source_code = str(row.get("ts_code") or "").upper()
            resolved = aliases.get(source_code)
            if resolved is None:
                continue
            canonical, priority = resolved
            if canonical in basics and priority >= priorities[canonical]:
                if priority > priorities[canonical]:
                    continue
                raise ActionValueFactorDatasetError(
                    "ACTION_VALUE_FACTOR_DAILY_BASIC_DUPLICATE"
                )
            basics[canonical] = row
            priorities[canonical] = priority
        return basics

    def build_partition(self, decision_date: str) -> dict:
        existing = self.db.execute(
            "SELECT expected_episode_count,full_universe_count,"
            "accepted_count,ready_count FROM factor_partitions "
            "WHERE decision_date=?",
            (decision_date,),
        ).fetchone()
        if existing:
            return {
                "decisionDate": decision_date,
                "status": "SKIPPED",
                **dict(existing),
            }
        episodes = {
            row["instrument_id"]: row["episode_id"]
            for row in self.label.execute(
                "SELECT DISTINCT episode_id,instrument_id FROM episode_labels "
                "WHERE decision_date=?",
                (decision_date,),
            )
        }
        if not episodes:
            raise ActionValueFactorDatasetError(
                "ACTION_VALUE_FACTOR_PARTITION_NOT_REQUIRED"
            )
        basics = self._daily_basics(decision_date)
        financial = self.financial_snapshots[decision_date]
        industries = industry_members_as_of(self.industries, decision_date)
        dividends = dividend_continuity_as_of(self.dividends, decision_date)
        normalized = []
        daily_hashes = {}
        for row in self.ranking.execute(
            "SELECT instrument_id,adjusted_return_20,adjusted_return_60,"
            "realized_volatility_20,realized_volatility_60 "
            "FROM ranking_samples WHERE decision_date=? "
            "ORDER BY instrument_id",
            (decision_date,),
        ):
            instrument_id = row["instrument_id"]
            code = _canonical_source_code(instrument_id)
            basic = basics.get(code) or {}
            report = financial.get(code) or {}
            circ_mv = _finite(basic.get("circ_mv"))
            source = build_multifactor_metrics({
                "code": instrument_id,
                "industry": industries.get(code, ""),
                "logFloatMarketCap": (
                    math.log1p(circ_mv)
                    if circ_mv is not None and circ_mv > 0
                    else None
                ),
                "peTtm": basic.get("pe_ttm"),
                "pb": basic.get("pb"),
                "psTtm": basic.get("ps_ttm"),
                "roeWaa": report.get("roeWaa"),
                "netProfitMargin": report.get("netProfitMargin"),
                "operatingCashToSales": report.get("operatingCashToSales"),
                "debtToAssets": report.get("debtToAssets"),
                "netProfitYoY": report.get("netProfitYoY"),
                "revenueYoY": report.get("revenueYoY"),
                "adjustedReturn20": row["adjusted_return_20"],
                "adjustedReturn60": row["adjusted_return_60"],
                "adjustedReturn120Ex5": None,
                "dividendYieldTtm": (
                    basic.get("dv_ttm")
                    if _finite(basic.get("dv_ttm")) is not None
                    else 0 if basic else None
                ),
                "dividendContinuity3Y": (
                    dividends.get(code, 0) if basic else None
                ),
                "realizedVolatility20": row["realized_volatility_20"],
                "realizedVolatility60": row["realized_volatility_60"],
                "downsideVolatility60": None,
                "reportPeriod": report.get("reportPeriod"),
                "reportAvailableAt": report.get("reportAvailableAt"),
            })
            normalized.append(source)
            daily_hashes[instrument_id] = (
                canonical_sha256(basic) if basic else None
            )
        scored = score_multifactor_cross_section(normalized)
        selected = []
        for row in scored:
            episode_id = episodes.get(row["code"])
            if episode_id is None:
                continue
            report_available = row.get("reportAvailableAt")
            if report_available and report_available > decision_date:
                raise ActionValueFactorDatasetError(
                    "ACTION_VALUE_FACTOR_FUTURE_FINANCIAL"
                )
            selected.append({
                "decisionDate": decision_date,
                "episodeId": episode_id,
                "instrumentId": row["code"],
                "state": row["state"],
                "scores": row["factorScores"],
                "metricScores": row["metricScores"],
                "missingFamilies": row["missingFamilies"],
                "reportPeriod": row.get("reportPeriod"),
                "reportAvailableAt": report_available,
                "asOf": (
                    f"{decision_date[:4]}-{decision_date[4:6]}-"
                    f"{decision_date[6:]}T21:00:00+08:00"
                ),
                "sourceRowSha256": canonical_sha256({
                    "dailyBasic": daily_hashes[row["code"]],
                    "factorScores": row["factorScores"],
                    "metricScores": row["metricScores"],
                    "reportPeriod": row.get("reportPeriod"),
                    "reportAvailableAt": report_available,
                }),
            })
        if len(selected) != len(episodes):
            raise ActionValueFactorDatasetError(
                "ACTION_VALUE_FACTOR_EPISODE_COVERAGE_INCOMPLETE"
            )
        selected.sort(key=lambda row: row["episodeId"])
        ready_count = sum(row["state"] == "READY" for row in selected)
        industry_count = sum(bool(row["industry"]) for row in normalized)
        payload_hash = canonical_sha256(selected)
        try:
            self.db.execute(
                "INSERT INTO factor_partitions VALUES (?,?,?,?,?,?,?,?)",
                (
                    decision_date,
                    len(episodes),
                    len(scored),
                    len(selected),
                    ready_count,
                    industry_count,
                    payload_hash,
                    _now(),
                ),
            )
            self.db.executemany(
                "INSERT INTO factor_rows VALUES "
                f"({','.join('?' for _ in range(16))})",
                [
                    (
                        row["decisionDate"],
                        row["episodeId"],
                        row["instrumentId"],
                        row["state"],
                        *(row["scores"][family] for family in FACTOR_FAMILIES),
                        json.dumps(
                            row["metricScores"],
                            sort_keys=True,
                            separators=(",", ":"),
                        ),
                        json.dumps(
                            row["missingFamilies"],
                            sort_keys=True,
                            separators=(",", ":"),
                        ),
                        row["reportPeriod"],
                        row["reportAvailableAt"],
                        row["asOf"],
                        row["sourceRowSha256"],
                    )
                    for row in selected
                ],
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return {
            "decisionDate": decision_date,
            "status": "COMPLETED",
            "expectedEpisodeCount": len(episodes),
            "fullUniverseCount": len(scored),
            "acceptedCount": len(selected),
            "readyCount": ready_count,
            "payloadSha256": payload_hash,
        }

    def build(self):
        for decision_date in self.pending_dates():
            yield self.build_partition(decision_date)

    def seal(self) -> dict:
        expected_partitions = len(self.decision_dates)
        expected_rows = self.label.execute(
            "SELECT COUNT(DISTINCT episode_id) FROM episode_labels"
        ).fetchone()[0]
        totals = dict(
            self.db.execute(
                "SELECT COUNT(*) AS partitions,SUM(accepted_count) AS rows,"
                "SUM(ready_count) AS ready_rows,"
                "MIN(decision_date) AS start_date,"
                "MAX(decision_date) AS end_date "
                "FROM factor_partitions"
            ).fetchone()
        )
        if (
            totals["partitions"] != expected_partitions
            or totals["rows"] != expected_rows
        ):
            raise ActionValueFactorDatasetError(
                "ACTION_VALUE_FACTOR_DATASET_INCOMPLETE"
            )
        ready_coverage = totals["ready_rows"] / totals["rows"]
        daily_failures = self.db.execute(
            "SELECT COUNT(*) FROM factor_partitions "
            "WHERE CAST(ready_count AS REAL)/accepted_count < ?",
            (POLICY["minimumDailyReadyCoverage"],),
        ).fetchone()[0]
        if (
            ready_coverage < POLICY["minimumReadyCoverage"]
            or daily_failures
        ):
            raise ActionValueFactorDatasetError(
                "ACTION_VALUE_FACTOR_READY_COVERAGE_INSUFFICIENT"
            )
        metadata = dict(
            self.db.execute(
                "SELECT * FROM factor_dataset_metadata"
            ).fetchone()
        )
        states = {
            row["state"]: row["count"]
            for row in self.db.execute(
                "SELECT state,COUNT(*) AS count FROM factor_rows GROUP BY state"
            )
        }
        self.db.commit()
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        if self.db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ActionValueFactorDatasetError(
                "ACTION_VALUE_FACTOR_SQLITE_INTEGRITY_FAILED"
            )
        database_hash = _file_sha256(self.database_path)
        manifest = {
            "datasetId": metadata["dataset_id"],
            "schemaVersion": metadata["schema_version"],
            "createdAt": metadata["created_at"],
            "sealedAt": _now(),
            "database": self.database_path.name,
            "databaseSha256": database_hash,
            "sourceArchiveSha256": metadata["source_archive_sha256"],
            "episodeDatasetId": metadata["episode_dataset_id"],
            "episodeDatabaseSha256": metadata["episode_database_sha256"],
            "labelDatasetId": metadata["label_dataset_id"],
            "labelDatabaseSha256": metadata["label_database_sha256"],
            "rankingDatasetId": metadata["ranking_dataset_id"],
            "rankingDatabaseSha256": metadata["ranking_database_sha256"],
            "marketDatasetId": metadata["market_dataset_id"],
            "marketDatabaseSha256": metadata["market_database_sha256"],
            "featureSchemaVersion": metadata["feature_schema_version"],
            "featureNames": list(FEATURE_NAMES),
            "policySha256": metadata["policy_sha256"],
            "partitions": totals["partitions"],
            "rows": totals["rows"],
            "readyRows": totals["ready_rows"],
            "readyCoverage": ready_coverage,
            "rowsByState": states,
            "startDate": totals["start_date"],
            "endDate": totals["end_date"],
        }
        temporary = self.manifest_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2)
            + "\n"
        )
        os.replace(temporary, self.manifest_path)
        return manifest


def _episode_dates(root: Path) -> list[str]:
    _manifest, database = _verified_dataset(
        root,
        schema_version="episode-dataset.v4",
        database_name="episodes.sqlite3",
    )
    connection = sqlite3.connect(
        f"{database.as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    try:
        return [
            row[0]
            for row in connection.execute(
                "SELECT DISTINCT decision_date FROM candidate_episodes "
                "ORDER BY decision_date"
            )
        ]
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    source = commands.add_parser("build-source")
    source.add_argument("--root", type=Path, required=True)
    source.add_argument("--episode-root", type=Path, required=True)
    source.add_argument("--workers", type=int, default=4)
    dataset = commands.add_parser("build-dataset")
    dataset.add_argument("--root", type=Path, required=True)
    dataset.add_argument("--dataset-id", required=True)
    dataset.add_argument("--source-root", type=Path, required=True)
    dataset.add_argument("--episode-root", type=Path, required=True)
    dataset.add_argument("--label-root", type=Path, required=True)
    dataset.add_argument("--ranking-root", type=Path, required=True)
    dataset.add_argument("--market-root", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "build-source":
        dates = _episode_dates(args.episode_root)
        counter = 0

        def progress(result):
            nonlocal counter
            counter += 1
            if counter % 25 == 0:
                print(json.dumps(result, sort_keys=True), flush=True)

        result = build_multifactor_source_archive(
            client=TushareClient(),
            output_root=args.root,
            decision_dates=dates,
            workers=args.workers,
            on_progress=progress,
        )
    else:
        with ActionValueFactorDataset(
            args.root,
            dataset_id=args.dataset_id,
            source_root=args.source_root,
            episode_dataset_root=args.episode_root,
            label_dataset_root=args.label_root,
            ranking_dataset_root=args.ranking_root,
            market_dataset_root=args.market_root,
        ) as factor_dataset:
            for index, partition in enumerate(factor_dataset.build(), 1):
                if index % 25 == 0:
                    print(json.dumps(partition, sort_keys=True), flush=True)
            result = factor_dataset.seal()
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
