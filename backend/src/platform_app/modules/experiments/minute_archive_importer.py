"""Strictly validate isolated historical minute archives for episode use."""

import gzip
import hashlib
import json
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path

from platform_app.modules.experiments.episode_dataset import (
    EpisodeDataset,
    EpisodeDatasetError,
    canonical_json,
    canonical_sha256,
)

AMOUNT_TOLERANCE_RATE = Decimal("0.0005")
AMOUNT_TOLERANCE_CNY = Decimal("2")
VOLUME_TOLERANCE_SHARES = Decimal("100")


class MinuteArchiveError(EpisodeDatasetError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _decimal_text(value, *, positive: bool = False) -> str:
    if isinstance(value, bool):
        raise MinuteArchiveError("MINUTE_INVALID_NUMBER")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise MinuteArchiveError("MINUTE_INVALID_NUMBER") from exc
    if not number.is_finite() or (positive and number <= 0) or (not positive and number < 0):
        raise MinuteArchiveError("MINUTE_INVALID_NUMBER")
    rendered = format(number.normalize(), "f")
    return "0" if rendered in {"-0", ""} else rendered


def _expected_bar_ends(trade_date: str) -> list[str]:
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


def _normalize_rows(rows: object, instrument_id: str, trade_date: str) -> list[dict]:
    if not isinstance(rows, list):
        raise MinuteArchiveError("MINUTE_ROWS_INVALID")
    code = instrument_id.split(".", maxsplit=1)[1]
    normalized = []
    for raw in rows:
        if not isinstance(raw, dict) or str(raw.get("code") or "") != code:
            raise MinuteArchiveError("MINUTE_INSTRUMENT_MISMATCH")
        timestamp = re.sub(r"\D", "", str(raw.get("date") or ""))
        if len(timestamp) != 14 or not timestamp.startswith(trade_date):
            raise MinuteArchiveError("MINUTE_DATE_MISMATCH")
        bar_end = datetime.strptime(timestamp, "%Y%m%d%H%M%S").strftime("%Y-%m-%d %H:%M:%S")
        prices = {
            name: Decimal(_decimal_text(raw.get(name), positive=True))
            for name in ("open", "high", "low", "close")
        }
        if prices["high"] < max(prices["open"], prices["close"]) or prices["low"] > min(
            prices["open"], prices["close"]
        ):
            raise MinuteArchiveError("MINUTE_INVALID_OHLC")
        volume = Decimal(_decimal_text(raw.get("volume")))
        if volume != volume.to_integral_value():
            raise MinuteArchiveError("MINUTE_VOLUME_NOT_INTEGER_SHARES")
        normalized.append(
            {
                "instrumentId": instrument_id,
                "tradeDate": trade_date,
                "barEndShanghai": bar_end,
                **{name: format(value, "f") for name, value in prices.items()},
                "volumeShares": format(volume, "f"),
                "amountCny": _decimal_text(raw.get("amount")),
                "sourceRowSha256": canonical_sha256(raw),
            }
        )
    normalized.sort(key=lambda row: row["barEndShanghai"])
    if [row["barEndShanghai"] for row in normalized] != _expected_bar_ends(trade_date):
        raise MinuteArchiveError("MINUTE_SESSION_INCOMPLETE")
    return normalized


def _validate_daily(rows: list[dict], daily: dict) -> dict:
    opening = Decimal(rows[0]["open"])
    closing = Decimal(rows[-1]["close"])
    high = max(Decimal(row["high"]) for row in rows)
    low = min(Decimal(row["low"]) for row in rows)
    if opening != Decimal(daily["open"]) or closing != Decimal(daily["close"]):
        raise MinuteArchiveError("MINUTE_DAILY_OPEN_CLOSE_MISMATCH")
    if high > Decimal(daily["high"]) or low < Decimal(daily["low"]):
        raise MinuteArchiveError("MINUTE_OUTSIDE_DAILY_RANGE")
    volume = sum((Decimal(row["volumeShares"]) for row in rows), Decimal(0))
    amount = sum((Decimal(row["amountCny"]) for row in rows), Decimal(0))
    volume_delta = volume - Decimal(daily["volume_shares"])
    amount_delta = amount - Decimal(daily["amount_cny"])
    if abs(volume_delta) >= VOLUME_TOLERANCE_SHARES:
        raise MinuteArchiveError("MINUTE_DAILY_VOLUME_MISMATCH")
    amount_tolerance = max(
        AMOUNT_TOLERANCE_CNY,
        abs(Decimal(daily["amount_cny"])) * AMOUNT_TOLERANCE_RATE,
    )
    if abs(amount_delta) > amount_tolerance:
        raise MinuteArchiveError("MINUTE_DAILY_AMOUNT_MISMATCH")
    return {
        "open": format(opening, "f"),
        "high": format(high, "f"),
        "low": format(low, "f"),
        "close": format(closing, "f"),
        "volumeShares": format(volume, "f"),
        "amountCny": format(amount, "f"),
        "volumeDeltaShares": format(volume_delta, "f"),
        "amountDeltaCny": format(amount_delta, "f"),
        "amountToleranceCny": format(amount_tolerance, "f"),
        "dailySourceRowSha256": daily["source_row_sha256"],
    }


class MinuteArchiveImporter:
    def __init__(self, dataset: EpisodeDataset, archive_root: Path):
        self.dataset = dataset
        self.root = archive_root.resolve()
        self.minute_root = self.root / "minutes"
        if not self.minute_root.is_dir():
            raise MinuteArchiveError("MINUTE_ARCHIVE_DIRECTORY_MISSING")
        self.source_kind, self.expected_hashes = self._identify_archive()
        uri = f"{dataset.market_database_path.resolve().as_uri()}?mode=ro&immutable=1"
        import sqlite3

        self.market = sqlite3.connect(uri, uri=True)
        self.market.row_factory = sqlite3.Row

    def _identify_archive(self) -> tuple[str, dict[str, str]]:
        tushare_report = self.root / "backfill-minutes-report.json"
        stockdb_manifest = self.root / "minute-manifest.json"
        stockdb_replay_manifest = self.root / "archive-replay-manifest.json"
        if tushare_report.is_file():
            report = json.loads(tushare_report.read_text())
            expected = {
                row["date"]: row["sha256"]
                for row in report.get("written", [])
                if re.fullmatch(r"\d{8}", str(row.get("date") or ""))
                and re.fullmatch(r"[0-9a-f]{64}", str(row.get("sha256") or ""))
            }
            if len(expected) != report.get("datesWritten"):
                raise MinuteArchiveError("TUSHARE_ARCHIVE_REPORT_INVALID")
            return "TUSHARE_5MIN_ARCHIVE_V1", expected
        if stockdb_replay_manifest.is_file() or stockdb_manifest.is_file():
            manifest_path = (
                stockdb_replay_manifest if stockdb_replay_manifest.is_file() else stockdb_manifest
            )
            manifest = json.loads(manifest_path.read_text())
            if manifest.get("schemaVersion") not in {
                "opportunity-archive-replay.v1",
                "stockdb-minute-export-manifest.v1",
            }:
                raise MinuteArchiveError("STOCKDB_ARCHIVE_MANIFEST_INVALID")
            dates = {
                str(row.get("date") or "")
                for row in manifest.get("dates", [])
                if isinstance(row, dict)
            }
            if not dates or any(not re.fullmatch(r"\d{8}", value) for value in dates):
                raise MinuteArchiveError("STOCKDB_ARCHIVE_MANIFEST_INVALID")
            return "STOCKDB_ISOLATED_ARCHIVE_V1", {value: "" for value in dates}
        raise MinuteArchiveError("MINUTE_ARCHIVE_IDENTITY_MISSING")

    def close(self) -> None:
        self.market.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()

    def import_range(self, start_date: str, end_date: str) -> list[dict]:
        results = []
        for path in sorted(self.minute_root.glob("*.json.gz")):
            trade_date = path.name.removesuffix(".json.gz")
            if start_date <= trade_date <= end_date:
                results.append(self.import_file(path, trade_date))
        return results

    def import_file(self, path: Path, trade_date: str) -> dict:
        if trade_date not in self.expected_hashes:
            raise MinuteArchiveError("MINUTE_ARCHIVE_DATE_NOT_DECLARED")
        asset_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        expected_hash = self.expected_hashes[trade_date]
        if expected_hash and asset_hash != expected_hash:
            raise MinuteArchiveError("MINUTE_ARCHIVE_HASH_MISMATCH")
        existing = self.dataset.db.execute(
            "SELECT source_asset_sha256 FROM minute_archive_files "
            "WHERE source_kind = ? AND trade_date = ?",
            (self.source_kind, trade_date),
        ).fetchone()
        if existing:
            if existing["source_asset_sha256"] != asset_hash:
                raise MinuteArchiveError("MINUTE_ARCHIVE_FILE_CONFLICT")
            return {
                "tradeDate": trade_date,
                "sourceKind": self.source_kind,
                "status": "SKIPPED",
            }

        with gzip.open(path, "rt", encoding="utf-8") as stream:
            payload = json.load(stream)
        if payload.get("date") != trade_date or not isinstance(payload.get("codes"), dict):
            raise MinuteArchiveError("MINUTE_ARCHIVE_PAYLOAD_INVALID")
        codes = payload["codes"]
        requirements = {
            row["instrument_id"].split(".", maxsplit=1)[1]: dict(row)
            for row in self.dataset.db.execute(
                "SELECT instrument_id, trade_date FROM minute_requirements "
                "WHERE trade_date = ? AND status = 'PENDING'",
                (trade_date,),
            )
        }
        matched_codes = sorted(set(codes) & set(requirements))
        accepted = 0
        rejected = 0
        attempted_at = _now()
        try:
            for code in matched_codes:
                requirement = requirements[code]
                instrument_id = requirement["instrument_id"]
                try:
                    rows = _normalize_rows(codes[code], instrument_id, trade_date)
                    daily = self.market.execute(
                        "SELECT * FROM daily_bars WHERE instrument_id = ? AND trade_date = ?",
                        (instrument_id, trade_date),
                    ).fetchone()
                    if not daily:
                        raise MinuteArchiveError("MINUTE_DAILY_BAR_MISSING")
                    details = _validate_daily(rows, dict(daily))
                    for row in rows:
                        self.dataset.db.execute(
                            "INSERT INTO episode_minute_bars VALUES "
                            "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            (
                                instrument_id,
                                trade_date,
                                row["barEndShanghai"],
                                row["open"],
                                row["high"],
                                row["low"],
                                row["close"],
                                row["volumeShares"],
                                row["amountCny"],
                                self.source_kind,
                                asset_hash,
                                row["sourceRowSha256"],
                            ),
                        )
                    self.dataset.db.execute(
                        "UPDATE minute_requirements SET status = 'COMPLETED', reason = NULL, "
                        "attempt_count = attempt_count + 1, last_attempt_at = ?, "
                        "completed_at = ? WHERE instrument_id = ? AND trade_date = ?",
                        (attempted_at, attempted_at, instrument_id, trade_date),
                    )
                    outcome = "ACCEPTED"
                    reason = None
                    accepted += 1
                except MinuteArchiveError as exc:
                    details = {}
                    outcome = "REJECTED"
                    reason = str(exc)
                    rejected += 1
                    self.dataset.db.execute(
                        "UPDATE minute_requirements SET reason = ?, "
                        "attempt_count = attempt_count + 1, last_attempt_at = ? "
                        "WHERE instrument_id = ? AND trade_date = ?",
                        (reason, attempted_at, instrument_id, trade_date),
                    )
                self.dataset.db.execute(
                    "INSERT INTO minute_ingestion_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        self.source_kind,
                        asset_hash,
                        instrument_id,
                        trade_date,
                        outcome,
                        reason,
                        canonical_json(details),
                        attempted_at,
                    ),
                )
            self.dataset.db.execute(
                "INSERT INTO minute_archive_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    self.source_kind,
                    trade_date,
                    asset_hash,
                    len(codes),
                    len(matched_codes),
                    accepted,
                    rejected,
                    attempted_at,
                ),
            )
            self.dataset.db.commit()
        except Exception:
            self.dataset.db.rollback()
            raise
        return {
            "tradeDate": trade_date,
            "sourceKind": self.source_kind,
            "status": "COMPLETED",
            "archiveCodes": len(codes),
            "matchedRequirements": len(matched_codes),
            "accepted": accepted,
            "rejected": rejected,
        }


__all__ = ["MinuteArchiveError", "MinuteArchiveImporter"]
