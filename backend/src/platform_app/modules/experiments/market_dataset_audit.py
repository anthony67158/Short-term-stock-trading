"""Read-only integrity audit for canonical market-dataset.v3 datasets."""

import hashlib
import re
import sqlite3
from bisect import bisect_left
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path

from platform_app.modules.experiments.market_dataset import (
    DAILY_TURNOVER_SCOPE,
    SCHEMA_VERSION,
    canonical_sha256,
)

EXPECTED_MINUTE_BARS = 48
MINUTE_VOLUME_TOLERANCE_SHARES = Decimal("100")
MINUTE_AMOUNT_TOLERANCE_RATE = Decimal("0.0005")
MINUTE_AMOUNT_TOLERANCE_CNY = Decimal("2")
MAX_EXAMPLES = 20


class MarketDatasetAuditError(ValueError):
    pass


def _sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _decimal(value: str) -> Decimal | None:
    try:
        parsed = Decimal(value)
    except (InvalidOperation, TypeError):
        return None
    return parsed if parsed.is_finite() else None


def _record(violations: dict, kind: str, identity: str) -> None:
    entry = violations.setdefault(kind, {"count": 0, "examples": []})
    entry["count"] += 1
    if len(entry["examples"]) < MAX_EXAMPLES:
        entry["examples"].append(identity)


def _expected_minute_ends(trade_date: str) -> list[str]:
    date = datetime.strptime(trade_date, "%Y%m%d").strftime("%Y-%m-%d")
    starts = (
        datetime.fromisoformat(f"{date} 09:35:00"),
        datetime.fromisoformat(f"{date} 13:05:00"),
    )
    return [
        (start + timedelta(minutes=5 * offset)).strftime("%Y-%m-%d %H:%M:%S")
        for start in starts
        for offset in range(24)
    ]


def _dates_in_lifecycle(
    open_dates: list[str], list_date: str, delist_date: str | None
) -> list[str]:
    start = bisect_left(open_dates, list_date)
    end = len(open_dates) if delist_date is None else bisect_left(open_dates, delist_date)
    return open_dates[start:end]


def _source_code_valid(
    source_code: str,
    canonical: str,
    aliases: list[sqlite3.Row],
    trade_date: str,
) -> bool:
    if source_code == canonical:
        return True
    return any(
        row["source_code"] == source_code
        and row["effective_from"] <= trade_date
        and (row["effective_to"] is None or row["effective_to"] >= trade_date)
        for row in aliases
    )


def _audit_instrument(
    db: sqlite3.Connection,
    instrument: sqlite3.Row,
    open_dates: list[str],
    violations: dict,
) -> dict:
    instrument_id = instrument["instrument_id"]
    aliases = db.execute(
        "SELECT source_code, effective_from, effective_to FROM instrument_aliases "
        "WHERE instrument_id = ? ORDER BY effective_from",
        (instrument_id,),
    ).fetchall()
    bars = db.execute(
        "SELECT * FROM daily_bars WHERE instrument_id = ? ORDER BY trade_date",
        (instrument_id,),
    ).fetchall()
    factors = db.execute(
        "SELECT trade_date, source_code, factor, available_at FROM adjustment_factors "
        "WHERE instrument_id = ? ORDER BY trade_date",
        (instrument_id,),
    ).fetchall()
    suspended_dates = {
        row["trade_date"]
        for row in db.execute(
            "SELECT trade_date FROM suspensions WHERE instrument_id = ? AND suspend_type = 'S'",
            (instrument_id,),
        )
    }
    status_periods = db.execute(
        "SELECT effective_from, effective_to FROM listing_status_periods WHERE instrument_id = ?",
        (instrument_id,),
    ).fetchall()
    expected_dates = _dates_in_lifecycle(
        open_dates, instrument["list_date"], instrument["delist_date"]
    )
    bar_dates = {row["trade_date"] for row in bars}
    factor_dates = {row["trade_date"] for row in factors}

    for row in bars:
        identity = f"{instrument_id}@{row['trade_date']}"
        values = {
            field: _decimal(row[field])
            for field in (
                "open",
                "high",
                "low",
                "close",
                "previous_close",
                "volume_shares",
                "amount_cny",
            )
        }
        if any(value is None for value in values.values()):
            _record(violations, "invalidDecimal", identity)
            continue
        if (
            not (
                Decimal("0")
                < values["low"]
                <= min(values["open"], values["close"])
                <= max(values["open"], values["close"])
                <= values["high"]
            )
            or values["previous_close"] <= 0
        ):
            _record(violations, "invalidDailyOHLC", identity)
        if values["volume_shares"] < 0 or values["amount_cny"] < 0:
            _record(violations, "negativeDailyVolumeOrAmount", identity)
        if row["turnover_scope"] != DAILY_TURNOVER_SCOPE:
            _record(violations, "invalidDailyTurnoverScope", identity)
        if row["trade_date"] < instrument["list_date"] or (
            instrument["delist_date"] is not None and row["trade_date"] >= instrument["delist_date"]
        ):
            _record(violations, "dailyOutsideLifecycle", identity)
        if not _source_code_valid(
            row["source_code"],
            instrument["source_code"],
            aliases,
            row["trade_date"],
        ):
            _record(violations, "dailySourceCodeMismatch", identity)
        expected_available = (
            f"{row['trade_date'][:4]}-{row['trade_date'][4:6]}-"
            f"{row['trade_date'][6:]}T16:30:00+08:00"
        )
        if row["available_at"] != expected_available:
            _record(violations, "dailyAvailabilityMismatch", identity)

    for row in factors:
        identity = f"{instrument_id}@{row['trade_date']}"
        factor = _decimal(row["factor"])
        if factor is None or factor <= 0:
            _record(violations, "invalidAdjustmentFactor", identity)
        if row["trade_date"] < instrument["list_date"] or (
            instrument["delist_date"] is not None and row["trade_date"] >= instrument["delist_date"]
        ):
            _record(violations, "factorOutsideLifecycle", identity)
        if not _source_code_valid(
            row["source_code"],
            instrument["source_code"],
            aliases,
            row["trade_date"],
        ):
            _record(violations, "factorSourceCodeMismatch", identity)
        expected_available = (
            f"{row['trade_date'][:4]}-{row['trade_date'][4:6]}-"
            f"{row['trade_date'][6:]}T09:20:00+08:00"
        )
        if row["available_at"] != expected_available:
            _record(violations, "factorAvailabilityMismatch", identity)

    for trade_date in sorted(bar_dates - factor_dates):
        _record(violations, "dailyMissingAdjustmentFactor", f"{instrument_id}@{trade_date}")

    unexplained = []
    for trade_date in expected_dates:
        if trade_date in bar_dates or trade_date in suspended_dates:
            continue
        if any(
            period["effective_from"] <= trade_date < period["effective_to"]
            for period in status_periods
        ):
            continue
        unexplained.append(trade_date)
        _record(violations, "unexplainedDailyCoverageGap", f"{instrument_id}@{trade_date}")

    return {
        "dailyBars": len(bars),
        "adjustmentFactors": len(factors),
        "expectedOpenDates": len(expected_dates),
        "explainedNoBarDates": len(set(expected_dates) - bar_dates) - len(unexplained),
    }


def _audit_minutes(db: sqlite3.Connection, violations: dict) -> dict:
    checkpoints = db.execute(
        "SELECT partition_key FROM sync_checkpoints "
        "WHERE stream = 'minute_5min' ORDER BY partition_key"
    ).fetchall()
    checked = 0
    for checkpoint in checkpoints:
        partition_key = checkpoint["partition_key"]
        instrument_id, trade_date = partition_key.split(":", maxsplit=1)
        date = datetime.strptime(trade_date, "%Y%m%d").strftime("%Y-%m-%d")
        rows = db.execute(
            "SELECT * FROM minute_bars WHERE instrument_id = ? "
            "AND substr(bar_end_shanghai, 1, 10) = ? ORDER BY bar_end_shanghai",
            (instrument_id, date),
        ).fetchall()
        if [row["bar_end_shanghai"] for row in rows] != _expected_minute_ends(trade_date):
            _record(violations, "invalidMinuteSession", partition_key)
            continue
        daily = db.execute(
            "SELECT * FROM daily_bars WHERE instrument_id = ? AND trade_date = ?",
            (instrument_id, trade_date),
        ).fetchone()
        if daily is None:
            _record(violations, "minuteDailyBarMissing", partition_key)
            continue
        values = [
            {
                field: _decimal(row[field])
                for field in ("open", "high", "low", "close", "volume_shares", "amount_cny")
            }
            for row in rows
        ]
        if any(any(value is None for value in item.values()) for item in values):
            _record(violations, "invalidMinuteDecimal", partition_key)
            continue
        if any(
            not (
                Decimal("0")
                < item["low"]
                <= min(item["open"], item["close"])
                <= max(item["open"], item["close"])
                <= item["high"]
            )
            or item["volume_shares"] < 0
            or item["amount_cny"] < 0
            for item in values
        ):
            _record(violations, "invalidMinuteOHLCOrAmount", partition_key)
        daily_values = {
            field: _decimal(daily[field])
            for field in ("open", "high", "low", "close", "volume_shares", "amount_cny")
        }
        if (
            values[0]["open"] != daily_values["open"]
            or values[-1]["close"] != daily_values["close"]
            or max(item["high"] for item in values) > daily_values["high"]
            or min(item["low"] for item in values) < daily_values["low"]
        ):
            _record(violations, "minutePriceAggregationMismatch", partition_key)
        volume_delta = sum(item["volume_shares"] for item in values) - daily_values["volume_shares"]
        amount_delta = sum(item["amount_cny"] for item in values) - daily_values["amount_cny"]
        amount_tolerance = max(
            MINUTE_AMOUNT_TOLERANCE_CNY,
            abs(daily_values["amount_cny"]) * MINUTE_AMOUNT_TOLERANCE_RATE,
        )
        if abs(volume_delta) >= MINUTE_VOLUME_TOLERANCE_SHARES:
            _record(violations, "minuteVolumeAggregationMismatch", partition_key)
        if abs(amount_delta) > amount_tolerance:
            _record(violations, "minuteAmountAggregationMismatch", partition_key)
        checked += 1

    orphan_groups = db.execute(
        "SELECT COUNT(*) FROM ("
        "SELECT instrument_id, substr(bar_end_shanghai, 1, 10) AS trade_date "
        "FROM minute_bars GROUP BY instrument_id, trade_date"
        ") groups WHERE NOT EXISTS ("
        "SELECT 1 FROM sync_checkpoints c WHERE c.stream = 'minute_5min' "
        "AND c.partition_key = groups.instrument_id || ':' || replace(groups.trade_date, '-', '')"
        ")"
    ).fetchone()[0]
    if orphan_groups:
        _record(violations, "minuteGroupsWithoutCheckpoint", str(orphan_groups))
    return {"checkpoints": len(checkpoints), "validatedPartitions": checked}


def _audit_block_trades(
    db: sqlite3.Connection,
    open_dates: list[str],
    violations: dict,
) -> dict:
    checkpoints = db.execute(
        "SELECT partition_key, row_count FROM sync_checkpoints "
        "WHERE stream = 'block_trades' ORDER BY partition_key"
    ).fetchall()
    checkpoint_dates = {row["partition_key"] for row in checkpoints}
    for trade_date in sorted(set(open_dates) - checkpoint_dates):
        _record(violations, "missingBlockTradeCheckpoint", trade_date)
    for trade_date in sorted(checkpoint_dates - set(open_dates)):
        _record(violations, "nonOpenBlockTradeCheckpoint", trade_date)

    summaries = db.execute(
        "SELECT b.*, i.source_code AS canonical_source_code, i.list_date, i.delist_date "
        "FROM block_trade_summaries b JOIN instruments i USING (instrument_id) "
        "ORDER BY b.trade_date, b.instrument_id"
    ).fetchall()
    for row in summaries:
        identity = f"{row['instrument_id']}@{row['trade_date']}"
        low = _decimal(row["low_price"])
        high = _decimal(row["high_price"])
        volume = _decimal(row["volume_shares"])
        amount = _decimal(row["amount_cny"])
        if (
            low is None
            or high is None
            or volume is None
            or amount is None
            or low <= 0
            or high < low
            or volume <= 0
            or amount <= 0
        ):
            _record(violations, "invalidBlockTradeSummary", identity)
        if row["trade_date"] < row["list_date"] or (
            row["delist_date"] is not None and row["trade_date"] >= row["delist_date"]
        ):
            _record(violations, "blockTradeOutsideLifecycle", identity)
        aliases = db.execute(
            "SELECT source_code, effective_from, effective_to FROM instrument_aliases "
            "WHERE instrument_id = ?",
            (row["instrument_id"],),
        ).fetchall()
        if not _source_code_valid(
            row["source_code"],
            row["canonical_source_code"],
            aliases,
            row["trade_date"],
        ):
            _record(violations, "blockTradeSourceCodeMismatch", identity)
        expected_available = (
            f"{row['trade_date'][:4]}-{row['trade_date'][4:6]}-"
            f"{row['trade_date'][6:]}T21:00:00+08:00"
        )
        if row["available_at"] != expected_available:
            _record(violations, "blockTradeAvailabilityMismatch", identity)
        if not re.fullmatch(r"[0-9a-f]{64}", row["source_rows_sha256"]):
            _record(violations, "invalidBlockTradeSourceHash", identity)
        if row["trade_date"] not in checkpoint_dates:
            _record(violations, "blockTradeSummaryWithoutCheckpoint", identity)

    transactions = 0
    for checkpoint in checkpoints:
        summarized = db.execute(
            "SELECT COALESCE(SUM(transaction_count), 0) FROM block_trade_summaries "
            "WHERE trade_date = ?",
            (checkpoint["partition_key"],),
        ).fetchone()[0]
        transactions += summarized
        if summarized != checkpoint["row_count"]:
            _record(
                violations,
                "blockTradeCheckpointCountMismatch",
                checkpoint["partition_key"],
            )
    return {
        "checkpoints": len(checkpoints),
        "summaryRows": len(summaries),
        "transactions": transactions,
    }


def audit_market_dataset(dataset_root: Path, *, observed_at=None) -> dict:
    database = dataset_root.resolve() / "market.sqlite3"
    if not database.is_file():
        raise MarketDatasetAuditError("MARKET_DATASET_MISSING")
    violations: dict = {}
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=30) as db:
        db.row_factory = sqlite3.Row
        integrity = [row[0] for row in db.execute("PRAGMA integrity_check")]
        metadata = db.execute("SELECT * FROM dataset_metadata").fetchone()
        if metadata is None or metadata["schema_version"] != SCHEMA_VERSION:
            raise MarketDatasetAuditError("MARKET_DATASET_SCHEMA_UNSUPPORTED")

        reference = db.execute(
            "SELECT partition_key FROM sync_checkpoints WHERE stream = 'reference'"
        ).fetchall()
        if len(reference) != 1:
            raise MarketDatasetAuditError("MARKET_DATASET_REFERENCE_CHECKPOINT_INVALID")
        start_date, end_date = reference[0]["partition_key"].split(":", maxsplit=1)
        open_dates = [
            row[0]
            for row in db.execute(
                "SELECT DISTINCT cal_date FROM trade_calendar "
                "WHERE is_open = 1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date",
                (start_date, end_date),
            )
        ]
        checkpoint_dates = [
            row[0]
            for row in db.execute(
                "SELECT partition_key FROM sync_checkpoints "
                "WHERE stream = 'daily' ORDER BY partition_key"
            )
        ]
        missing_checkpoints = sorted(set(open_dates) - set(checkpoint_dates))
        extra_checkpoints = sorted(set(checkpoint_dates) - set(open_dates))
        for trade_date in missing_checkpoints:
            _record(violations, "missingDailyCheckpoint", trade_date)
        for trade_date in extra_checkpoints:
            _record(violations, "nonOpenDailyCheckpoint", trade_date)

        totals = {
            "instruments": 0,
            "dailyBars": 0,
            "adjustmentFactors": 0,
            "expectedOpenDates": 0,
            "explainedNoBarDates": 0,
        }
        boards: dict[str, int] = {}
        instruments = db.execute("SELECT * FROM instruments ORDER BY instrument_id")
        for instrument in instruments:
            totals["instruments"] += 1
            boards[instrument["board"]] = boards.get(instrument["board"], 0) + 1
            result = _audit_instrument(db, instrument, open_dates, violations)
            for key, value in result.items():
                totals[key] += value

        structural_counts = {
            table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in (
                "instrument_aliases",
                "trade_calendar",
                "suspensions",
                "listing_status_periods",
                "name_changes",
                "minute_bars",
                "block_trade_summaries",
                "sync_checkpoints",
            )
        }
        invalid_names = db.execute(
            "SELECT COUNT(*) FROM name_changes WHERE end_date IS NOT NULL AND end_date < start_date"
        ).fetchone()[0]
        if invalid_names:
            _record(violations, "invalidNameChangeInterval", str(invalid_names))
        block_trade_summary = _audit_block_trades(db, open_dates, violations)
        minute_summary = _audit_minutes(db, violations)

    observed = (observed_at or (lambda: datetime.now(UTC).isoformat()))()
    report = {
        "schemaVersion": "market-dataset-audit.v1",
        "datasetId": metadata["dataset_id"],
        "datasetSchemaVersion": metadata["schema_version"],
        "canonicalSource": metadata["source"],
        "observedAt": observed,
        "database": {
            "bytes": database.stat().st_size,
            "sha256": _sha256(database),
            "integrityCheck": integrity,
        },
        "range": {
            "from": start_date,
            "to": end_date,
            "openDates": len(open_dates),
            "dailyCheckpoints": len(checkpoint_dates),
            "blockTradeCheckpoints": block_trade_summary["checkpoints"],
        },
        "totals": totals,
        "boards": dict(sorted(boards.items())),
        "tables": structural_counts,
        "minutes": minute_summary,
        "blockTrades": block_trade_summary,
        "violations": violations,
        "passed": integrity == ["ok"] and not violations,
    }
    report["reportSha256"] = canonical_sha256(report)
    return report
