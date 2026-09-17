"""Sealed virtual dataset for point-in-time return-distribution training."""

import argparse
import hashlib
import json
import os
import re
import sqlite3
from datetime import UTC, datetime
from decimal import Decimal, localcontext
from pathlib import Path

from platform_app.modules.experiments.cash_equity_fees import (
    CASH_EQUITY_FEE_POLICY,
    calculate_cash_equity_fees,
)
from platform_app.modules.experiments.episode_dataset import canonical_json

SCHEMA_VERSION = "foundation-return-dataset.v1"
FEATURE_SCHEMA_VERSION = "foundation-return-point-in-time-sequence.v1"
LABEL_POLICY_VERSION = "foundation-return-reference-labels.v1"
DEFAULT_HISTORY_SESSIONS = 90
MINIMUM_HISTORY_SESSIONS = 60
MAXIMUM_HISTORY_SESSIONS = 120
REFERENCE_NOTIONAL_CNY = Decimal("100000")

FEATURE_SCHEMA = {
    "schemaVersion": FEATURE_SCHEMA_VERSION,
    "layout": "TIME_MAJOR",
    "historySessionsRange": [
        MINIMUM_HISTORY_SESSIONS,
        MAXIMUM_HISTORY_SESSIONS,
    ],
    "channels": [
        "open",
        "high",
        "low",
        "close",
        "adjustedOpen",
        "adjustedHigh",
        "adjustedLow",
        "adjustedClose",
        "volumeShares",
        "amountCny",
        "adjustmentFactor",
    ],
    "timeAuthority": "TRADE_DATE_NOT_AFTER_DECISION_DATE",
    "availabilityAuthority": "MAX_DAILY_AND_ADJUSTMENT_AVAILABLE_AT",
}

LABEL_POLICY = {
    "policyVersion": LABEL_POLICY_VERSION,
    "referenceTarget": {
        "targetId": "REFERENCE_FULL_FILL_FEE_ADJUSTED_5D",
        "grossReturnSource": "ranking_samples.forward_return_next_open_5",
        "entry": "NEXT_SESSION_ADJUSTED_OPEN_FULL_FILL",
        "exit": "FIFTH_SESSION_ADJUSTED_CLOSE_WITH_MARKET_EXIT_SLIPPAGE",
        "referenceNotionalCny": "100000",
        "returnDenominator": "BUY_GROSS_PLUS_BUY_FEES",
        "feePolicyVersion": CASH_EQUITY_FEE_POLICY["policyVersion"],
    },
    "executionTarget": {
        "source": "label-dataset.v2 episode_labels WHERE reference_100k = 1",
        "coverage": "CANDIDATE_EPISODES_WITH_COMPLETE_MINUTE_PATH_ONLY",
        "missingSemantics": "MISSING_NOT_ZERO",
        "conditionalReturn": "net_return_given_fill",
    },
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS foundation_dataset_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    dataset_id TEXT NOT NULL UNIQUE,
    schema_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    history_sessions INTEGER NOT NULL CHECK (history_sessions BETWEEN 60 AND 120),
    ranking_dataset_id TEXT NOT NULL,
    ranking_schema_version TEXT NOT NULL,
    ranking_database_sha256 TEXT NOT NULL,
    market_dataset_id TEXT NOT NULL,
    market_schema_version TEXT NOT NULL,
    market_database_sha256 TEXT NOT NULL,
    execution_dataset_id TEXT NOT NULL,
    execution_schema_version TEXT NOT NULL,
    execution_database_sha256 TEXT NOT NULL,
    feature_schema_sha256 TEXT NOT NULL,
    feature_schema_json TEXT NOT NULL,
    label_policy_sha256 TEXT NOT NULL,
    label_policy_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS foundation_dataset_statistics (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    reference_sample_count INTEGER NOT NULL CHECK (reference_sample_count > 0),
    instrument_count INTEGER NOT NULL CHECK (instrument_count > 0),
    decision_date_count INTEGER NOT NULL CHECK (decision_date_count > 0),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    execution_covered_sample_count INTEGER NOT NULL
        CHECK (execution_covered_sample_count >= 0),
    execution_fill_count INTEGER NOT NULL CHECK (execution_fill_count >= 0),
    execution_no_fill_count INTEGER NOT NULL CHECK (execution_no_fill_count >= 0),
    execution_conditional_return_count INTEGER NOT NULL
        CHECK (execution_conditional_return_count >= 0),
    sealed_at TEXT NOT NULL
) STRICT;
"""


class FoundationReturnDatasetError(ValueError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _text(value: Decimal) -> str:
    rendered = format(value.normalize(), "f")
    return "0" if rendered in {"", "-0"} else rendered


def _decimal(value, error: str) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite():
        raise FoundationReturnDatasetError(error)
    return result


def _verified_upstream(root: Path, expected_schema: str) -> tuple[dict, Path]:
    resolved = root.expanduser().resolve()
    manifest_path = resolved / "manifest.json"
    if not manifest_path.is_file():
        raise FoundationReturnDatasetError("FOUNDATION_UPSTREAM_NOT_SEALED")
    try:
        manifest = json.loads(manifest_path.read_text())
        database = resolved / manifest["database"]
        expected_hash = manifest["databaseSha256"]
    except (KeyError, json.JSONDecodeError, TypeError) as exc:
        raise FoundationReturnDatasetError(
            "FOUNDATION_UPSTREAM_MANIFEST_INVALID",
        ) from exc
    if (
        manifest.get("schemaVersion") != expected_schema
        or re.fullmatch(r"[0-9a-f]{64}", str(expected_hash)) is None
        or not database.is_file()
        or _file_sha256(database) != expected_hash
    ):
        raise FoundationReturnDatasetError("FOUNDATION_UPSTREAM_INVALID")
    return manifest, database


def reference_full_fill_net_return(
    *,
    gross_return: str | Decimal,
    board: str,
    execution_date: str,
    terminal_date: str,
) -> Decimal:
    """Apply the frozen fee/slippage policy to a synthetic 100k full fill."""
    gross = _decimal(gross_return, "FOUNDATION_GROSS_RETURN_INVALID")
    if gross <= Decimal("-1"):
        raise FoundationReturnDatasetError("FOUNDATION_GROSS_RETURN_INVALID")
    slippage_bps = _decimal(
        CASH_EQUITY_FEE_POLICY["marketExitSlippageBps"]["value"],
        "FOUNDATION_SLIPPAGE_INVALID",
    )
    with localcontext() as context:
        context.prec = 28
        buy_gross = REFERENCE_NOTIONAL_CNY
        raw_sell_gross = buy_gross * (Decimal(1) + gross)
        sell_gross = raw_sell_gross * (
            Decimal(1) - slippage_bps / Decimal("10000")
        )
        if sell_gross <= 0:
            raise FoundationReturnDatasetError("FOUNDATION_SELL_GROSS_INVALID")
        buy_fees = calculate_cash_equity_fees(
            side="BUY",
            gross_amount=buy_gross,
            board=board,
            trade_date=execution_date,
        )["totalCny"]
        sell_fees = calculate_cash_equity_fees(
            side="SELL",
            gross_amount=sell_gross,
            board=board,
            trade_date=terminal_date,
        )["totalCny"]
        return (
            sell_gross - sell_fees - buy_gross - buy_fees
        ) / (buy_gross + buy_fees)


class FoundationReturnDataset:
    """Create a small immutable manifest that references sealed upstream datasets."""

    def __init__(
        self,
        root: Path,
        *,
        dataset_id: str,
        ranking_dataset_root: Path,
        market_dataset_root: Path,
        execution_label_dataset_root: Path,
        history_sessions: int = DEFAULT_HISTORY_SESSIONS,
    ):
        if not MINIMUM_HISTORY_SESSIONS <= history_sessions <= MAXIMUM_HISTORY_SESSIONS:
            raise FoundationReturnDatasetError(
                "FOUNDATION_HISTORY_SESSIONS_INVALID",
            )
        self.root = root.expanduser().resolve()
        self.database_path = self.root / "foundation.sqlite3"
        self.manifest_path = self.root / "data-manifest.json"
        if self.manifest_path.exists():
            raise FoundationReturnDatasetError("FOUNDATION_DATASET_ALREADY_SEALED")

        ranking, self.ranking_database_path = _verified_upstream(
            ranking_dataset_root,
            "ranking-dataset.v1",
        )
        market, self.market_database_path = _verified_upstream(
            market_dataset_root,
            "market-dataset.v4",
        )
        execution, self.execution_database_path = _verified_upstream(
            execution_label_dataset_root,
            "label-dataset.v2",
        )
        market_hash = market["databaseSha256"]
        if (
            ranking.get("marketDatabaseSha256") != market_hash
            or execution.get("marketDatabaseSha256") != market_hash
        ):
            raise FoundationReturnDatasetError(
                "FOUNDATION_UPSTREAM_LINEAGE_MISMATCH",
            )

        feature_schema = {
            **FEATURE_SCHEMA,
            "historySessions": history_sessions,
        }
        feature_json = canonical_json(feature_schema)
        label_json = canonical_json(LABEL_POLICY)
        identity = (
            dataset_id,
            SCHEMA_VERSION,
            history_sessions,
            ranking["datasetId"],
            ranking["schemaVersion"],
            ranking["databaseSha256"],
            market["datasetId"],
            market["schemaVersion"],
            market_hash,
            execution["datasetId"],
            execution["schemaVersion"],
            execution["databaseSha256"],
            hashlib.sha256(feature_json.encode()).hexdigest(),
            feature_json,
            hashlib.sha256(label_json.encode()).hexdigest(),
            label_json,
        )
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.database_path, autocommit=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        existing = self.db.execute(
            "SELECT dataset_id, schema_version, history_sessions, "
            "ranking_dataset_id, ranking_schema_version, ranking_database_sha256, "
            "market_dataset_id, market_schema_version, market_database_sha256, "
            "execution_dataset_id, execution_schema_version, "
            "execution_database_sha256, feature_schema_sha256, "
            "feature_schema_json, label_policy_sha256, label_policy_json "
            "FROM foundation_dataset_metadata"
        ).fetchone()
        if existing and tuple(existing) != identity:
            self.close()
            raise FoundationReturnDatasetError(
                "FOUNDATION_DATASET_IDENTITY_MISMATCH",
            )
        if not existing:
            self.db.execute(
                "INSERT INTO foundation_dataset_metadata VALUES "
                "(1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (dataset_id, SCHEMA_VERSION, _now(), *identity[2:]),
            )
            self.db.commit()

        self.ranking = self._open_readonly(self.ranking_database_path)
        execution_uri = (
            f"{self.execution_database_path.resolve().as_uri()}?mode=ro&immutable=1"
        )
        self.ranking.execute(
            "ATTACH DATABASE ? AS execution_labels",
            (execution_uri,),
        )

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

    def _statistics(self) -> dict:
        ranking = dict(
            self.ranking.execute(
                "SELECT COUNT(*) AS reference_sample_count, "
                "COUNT(DISTINCT instrument_id) AS instrument_count, "
                "COUNT(DISTINCT decision_date) AS decision_date_count, "
                "MIN(decision_date) AS start_date, MAX(decision_date) AS end_date "
                "FROM ranking_samples",
            ).fetchone()
        )
        if not ranking["reference_sample_count"]:
            raise FoundationReturnDatasetError("FOUNDATION_RANKING_EMPTY")

        rows = self.ranking.execute(
            "SELECT e.decision_date, e.instrument_id, e.board, "
            "e.p_fill_label, e.p_full_fill_label, e.fill_ratio, "
            "e.net_return_given_fill, r.board AS ranking_board "
            "FROM execution_labels.episode_labels e "
            "LEFT JOIN ranking_samples r "
            "ON r.instrument_id = e.instrument_id "
            "AND r.decision_date = e.decision_date "
            "WHERE e.reference_100k = 1 "
            "ORDER BY e.decision_date, e.instrument_id",
        )
        seen: set[tuple[str, str]] = set()
        covered = fills = no_fills = conditional_returns = 0
        for row in rows:
            key = (row["decision_date"], row["instrument_id"])
            if key in seen:
                raise FoundationReturnDatasetError(
                    "FOUNDATION_EXECUTION_LABEL_DUPLICATE",
                )
            seen.add(key)
            if row["ranking_board"] is None or row["ranking_board"] != row["board"]:
                raise FoundationReturnDatasetError(
                    "FOUNDATION_EXECUTION_LABEL_RANKING_MISMATCH",
                )
            has_fill = row["p_fill_label"] == 1
            has_conditional_return = row["net_return_given_fill"] is not None
            if has_fill != has_conditional_return:
                raise FoundationReturnDatasetError(
                    "FOUNDATION_EXECUTION_CONDITIONAL_LABEL_INVALID",
                )
            covered += 1
            fills += int(has_fill)
            no_fills += int(not has_fill)
            conditional_returns += int(has_conditional_return)
        return {
            **ranking,
            "execution_covered_sample_count": covered,
            "execution_fill_count": fills,
            "execution_no_fill_count": no_fills,
            "execution_conditional_return_count": conditional_returns,
        }

    def seal(self) -> dict:
        existing = self.db.execute(
            "SELECT * FROM foundation_dataset_statistics",
        ).fetchone()
        statistics = self._statistics()
        sealed_at = existing["sealed_at"] if existing else _now()
        expected = (
            statistics["reference_sample_count"],
            statistics["instrument_count"],
            statistics["decision_date_count"],
            statistics["start_date"],
            statistics["end_date"],
            statistics["execution_covered_sample_count"],
            statistics["execution_fill_count"],
            statistics["execution_no_fill_count"],
            statistics["execution_conditional_return_count"],
        )
        if existing:
            actual = tuple(existing)[1:-1]
            if actual != expected:
                raise FoundationReturnDatasetError(
                    "FOUNDATION_DATASET_STATISTICS_DRIFT",
                )
        else:
            self.db.execute(
                "INSERT INTO foundation_dataset_statistics VALUES "
                "(1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (*expected, sealed_at),
            )
            self.db.commit()
        if self.db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise FoundationReturnDatasetError(
                "FOUNDATION_DATASET_INTEGRITY_FAILED",
            )

        metadata = dict(
            self.db.execute("SELECT * FROM foundation_dataset_metadata").fetchone()
        )
        database_hash = _file_sha256(self.database_path)
        manifest = {
            "datasetId": metadata["dataset_id"],
            "schemaVersion": metadata["schema_version"],
            "createdAt": metadata["created_at"],
            "sealedAt": sealed_at,
            "database": self.database_path.name,
            "databaseSha256": database_hash,
            "storageMode": "VIRTUAL_SEALED_UPSTREAM_REFERENCES",
            "historySessions": metadata["history_sessions"],
            "featureSchemaSha256": metadata["feature_schema_sha256"],
            "labelPolicySha256": metadata["label_policy_sha256"],
            "feePolicyVersion": CASH_EQUITY_FEE_POLICY["policyVersion"],
            "rankingDataset": {
                "datasetId": metadata["ranking_dataset_id"],
                "schemaVersion": metadata["ranking_schema_version"],
                "databaseSha256": metadata["ranking_database_sha256"],
            },
            "marketDataset": {
                "datasetId": metadata["market_dataset_id"],
                "schemaVersion": metadata["market_schema_version"],
                "databaseSha256": metadata["market_database_sha256"],
            },
            "executionLabelDataset": {
                "datasetId": metadata["execution_dataset_id"],
                "schemaVersion": metadata["execution_schema_version"],
                "databaseSha256": metadata["execution_database_sha256"],
            },
            "referenceSamples": statistics["reference_sample_count"],
            "instruments": statistics["instrument_count"],
            "decisionDates": statistics["decision_date_count"],
            "startDate": statistics["start_date"],
            "endDate": statistics["end_date"],
            "executionCoverage": {
                "coveredSamples": statistics["execution_covered_sample_count"],
                "fillLabels": statistics["execution_fill_count"],
                "noFillLabels": statistics["execution_no_fill_count"],
                "conditionalReturnLabels": statistics[
                    "execution_conditional_return_count"
                ],
                "missingSemantics": "MISSING_NOT_ZERO",
            },
        }
        temporary = self.manifest_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        )
        os.replace(temporary, self.manifest_path)
        return manifest


def verify_foundation_return_dataset(root: Path) -> tuple[dict, Path]:
    resolved = root.expanduser().resolve()
    manifest_path = resolved / "data-manifest.json"
    if not manifest_path.is_file():
        raise FoundationReturnDatasetError("FOUNDATION_DATASET_NOT_SEALED")
    try:
        manifest = json.loads(manifest_path.read_text())
        database = resolved / manifest["database"]
        expected_hash = manifest["databaseSha256"]
    except (KeyError, json.JSONDecodeError, TypeError) as exc:
        raise FoundationReturnDatasetError(
            "FOUNDATION_DATASET_MANIFEST_INVALID",
        ) from exc
    if (
        manifest.get("schemaVersion") != SCHEMA_VERSION
        or re.fullmatch(r"[0-9a-f]{64}", str(expected_hash)) is None
        or not database.is_file()
        or _file_sha256(database) != expected_hash
    ):
        raise FoundationReturnDatasetError("FOUNDATION_DATASET_INVALID")
    return manifest, database


class FoundationReturnDatasetReader:
    def __init__(
        self,
        root: Path,
        *,
        ranking_dataset_root: Path,
        market_dataset_root: Path,
        execution_label_dataset_root: Path,
    ):
        self.manifest, foundation_database = verify_foundation_return_dataset(root)
        ranking, ranking_database = _verified_upstream(
            ranking_dataset_root,
            "ranking-dataset.v1",
        )
        market, market_database = _verified_upstream(
            market_dataset_root,
            "market-dataset.v4",
        )
        execution, execution_database = _verified_upstream(
            execution_label_dataset_root,
            "label-dataset.v2",
        )
        expected = (
            self.manifest["rankingDataset"]["databaseSha256"],
            self.manifest["marketDataset"]["databaseSha256"],
            self.manifest["executionLabelDataset"]["databaseSha256"],
        )
        actual = (
            ranking["databaseSha256"],
            market["databaseSha256"],
            execution["databaseSha256"],
        )
        if (
            actual != expected
            or ranking.get("marketDatabaseSha256") != actual[1]
            or execution.get("marketDatabaseSha256") != actual[1]
        ):
            raise FoundationReturnDatasetError(
                "FOUNDATION_READER_LINEAGE_MISMATCH",
            )
        self.foundation = FoundationReturnDataset._open_readonly(foundation_database)
        self.ranking = FoundationReturnDataset._open_readonly(ranking_database)
        self.market = FoundationReturnDataset._open_readonly(market_database)
        self.execution = FoundationReturnDataset._open_readonly(execution_database)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()

    def close(self) -> None:
        self.execution.close()
        self.market.close()
        self.ranking.close()
        self.foundation.close()

    def _ranking_sample(self, instrument_id: str, decision_date: str) -> sqlite3.Row:
        row = self.ranking.execute(
            "SELECT instrument_id, decision_date, board, execution_date, "
            "terminal_date, feature_available_at, forward_return_next_open_5 "
            "FROM ranking_samples WHERE instrument_id = ? AND decision_date = ?",
            (instrument_id, decision_date),
        ).fetchone()
        if row is None:
            raise FoundationReturnDatasetError(
                "FOUNDATION_REFERENCE_SAMPLE_NOT_FOUND",
            )
        return row

    def load_history_sequence(
        self,
        instrument_id: str,
        decision_date: str,
    ) -> dict:
        sample = self._ranking_sample(instrument_id, decision_date)
        history_sessions = int(self.manifest["historySessions"])
        rows = self.market.execute(
            "SELECT d.trade_date, d.open, d.high, d.low, d.close, "
            "d.volume_shares, d.amount_cny, d.available_at AS daily_available_at, "
            "a.factor, a.available_at AS factor_available_at "
            "FROM daily_bars d JOIN adjustment_factors a "
            "ON a.instrument_id = d.instrument_id AND a.trade_date = d.trade_date "
            "WHERE d.instrument_id = ? AND d.trade_date <= ? "
            "ORDER BY d.trade_date DESC LIMIT ?",
            (instrument_id, decision_date, history_sessions),
        ).fetchall()
        if (
            len(rows) != history_sessions
            or rows[0]["trade_date"] != decision_date
            or any(row["trade_date"] > decision_date for row in rows)
        ):
            raise FoundationReturnDatasetError(
                "FOUNDATION_HISTORY_SEQUENCE_INCOMPLETE",
            )
        sequence = []
        for row in reversed(rows):
            factor = _decimal(row["factor"], "FOUNDATION_FACTOR_INVALID")
            if factor <= 0:
                raise FoundationReturnDatasetError("FOUNDATION_FACTOR_INVALID")
            raw_prices = {
                name: _decimal(row[name], "FOUNDATION_PRICE_INVALID")
                for name in ("open", "high", "low", "close")
            }
            if min(raw_prices.values()) <= 0:
                raise FoundationReturnDatasetError("FOUNDATION_PRICE_INVALID")
            sequence.append(
                {
                    "tradeDate": row["trade_date"],
                    **{name: _text(value) for name, value in raw_prices.items()},
                    **{
                        f"adjusted{name.title()}": _text(value * factor)
                        for name, value in raw_prices.items()
                    },
                    "volumeShares": row["volume_shares"],
                    "amountCny": row["amount_cny"],
                    "adjustmentFactor": _text(factor),
                    "dailyAvailableAt": row["daily_available_at"],
                    "factorAvailableAt": row["factor_available_at"],
                }
            )
        feature_available_at = max(
            value
            for row in sequence
            for value in (row["dailyAvailableAt"], row["factorAvailableAt"])
        )
        if feature_available_at != sample["feature_available_at"]:
            raise FoundationReturnDatasetError(
                "FOUNDATION_FEATURE_AVAILABILITY_MISMATCH",
            )
        return {
            "schemaVersion": FEATURE_SCHEMA_VERSION,
            "featureSchemaSha256": self.manifest["featureSchemaSha256"],
            "instrumentId": instrument_id,
            "decisionDate": decision_date,
            "historySessions": history_sessions,
            "featureAvailableAt": feature_available_at,
            "rows": sequence,
        }

    def load_targets(self, instrument_id: str, decision_date: str) -> dict:
        sample = self._ranking_sample(instrument_id, decision_date)
        net_return = reference_full_fill_net_return(
            gross_return=sample["forward_return_next_open_5"],
            board=sample["board"],
            execution_date=sample["execution_date"],
            terminal_date=sample["terminal_date"],
        )
        execution_rows = self.execution.execute(
            "SELECT p_fill_label, p_full_fill_label, fill_ratio, "
            "p_win_given_fill_label, net_return_given_fill, stop_hazard_label "
            "FROM episode_labels WHERE decision_date = ? AND instrument_id = ? "
            "AND reference_100k = 1",
            (decision_date, instrument_id),
        ).fetchall()
        if len(execution_rows) > 1:
            raise FoundationReturnDatasetError(
                "FOUNDATION_EXECUTION_LABEL_DUPLICATE",
            )
        execution = None
        if execution_rows:
            row = execution_rows[0]
            execution = {
                "coverage": "AVAILABLE",
                "pFillLabel": row["p_fill_label"],
                "pFullFillLabel": row["p_full_fill_label"],
                "fillRatioLabel": row["fill_ratio"],
                "pWinGivenFillLabel": row["p_win_given_fill_label"],
                "netReturnGivenFill": row["net_return_given_fill"],
                "stopHazardLabel": row["stop_hazard_label"],
            }
        return {
            "labelPolicyVersion": LABEL_POLICY_VERSION,
            "labelPolicySha256": self.manifest["labelPolicySha256"],
            "instrumentId": instrument_id,
            "decisionDate": decision_date,
            "horizon": "5_TRADING_SESSIONS_AFTER_NEXT_OPEN",
            "referenceTargetKind": "REFERENCE_FULL_FILL_FEE_ADJUSTED_5D",
            "referenceGrossReturn5d": sample["forward_return_next_open_5"],
            "referenceNetReturn5d": _text(net_return),
            "directionLabel": int(net_return > 0),
            "execution": execution,
        }

    def load_sample(self, instrument_id: str, decision_date: str) -> dict:
        return {
            "sequence": self.load_history_sequence(instrument_id, decision_date),
            "targets": self.load_targets(instrument_id, decision_date),
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--ranking-root", type=Path, required=True)
    parser.add_argument("--market-root", type=Path, required=True)
    parser.add_argument("--execution-label-root", type=Path, required=True)
    parser.add_argument(
        "--history-sessions",
        type=int,
        default=DEFAULT_HISTORY_SESSIONS,
    )
    args = parser.parse_args()
    with FoundationReturnDataset(
        args.root,
        dataset_id=args.dataset_id,
        ranking_dataset_root=args.ranking_root,
        market_dataset_root=args.market_root,
        execution_label_dataset_root=args.execution_label_root,
        history_sessions=args.history_sessions,
    ) as dataset:
        print(json.dumps(dataset.seal(), ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
