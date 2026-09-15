"""Independent public-source checks for canonical daily market bars."""

import sqlite3
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import httpx

from platform_app.adapters.market_history_public import (
    PublicHistoryError,
    SinaDailyClient,
    TencentDailyClient,
)
from platform_app.modules.experiments.market_dataset import canonical_sha256

PRICE_FIELDS = ("open", "high", "low", "close")
VOLUME_TOLERANCE_SHARES = Decimal("100")


class CrossSourceAuditError(ValueError):
    pass


def _comparison(canonical: dict, public: dict) -> dict:
    price_matches = {
        field: Decimal(canonical[field]) == Decimal(public[field]) for field in PRICE_FIELDS
    }
    volume_delta = Decimal(public["volumeShares"]) - Decimal(canonical["volume_shares"])
    return {
        "priceMatches": price_matches,
        "volumeDeltaShares": format(volume_delta, "f"),
        "volumeWithinTolerance": abs(volume_delta) < VOLUME_TOLERANCE_SHARES,
        "matches": all(price_matches.values()) and abs(volume_delta) < VOLUME_TOLERANCE_SHARES,
    }


def _source_result(source: str, rows: dict[str, dict], trade_date: str, canonical: dict) -> dict:
    row = rows.get(trade_date)
    if row is None:
        return {"source": source, "available": False, "reason": "DATE_NOT_RETURNED"}
    comparison = _comparison(canonical, row)
    return {
        "source": source,
        "available": True,
        "sourceRowSha256": canonical_sha256(row),
        "bar": row,
        **comparison,
    }


def audit_cross_sources(
    dataset_root: Path,
    samples: list[tuple[str, str]],
    *,
    sina: SinaDailyClient | None = None,
    tencent: TencentDailyClient | None = None,
    observed_at=None,
) -> dict:
    if not samples or len(samples) != len(set(samples)):
        raise CrossSourceAuditError("CROSS_SOURCE_SAMPLES_INVALID")
    database = dataset_root.resolve() / "market.sqlite3"
    if not database.is_file():
        raise CrossSourceAuditError("CROSS_SOURCE_DATASET_MISSING")
    sina = sina or SinaDailyClient()
    tencent = tencent or TencentDailyClient()
    observed = (observed_at or (lambda: datetime.now(UTC).isoformat()))()
    results = []
    sina_cache: dict[str, dict[str, dict] | Exception] = {}

    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=5) as db:
        db.row_factory = sqlite3.Row
        metadata = db.execute(
            "SELECT dataset_id, schema_version, source FROM dataset_metadata"
        ).fetchone()
        if not metadata:
            raise CrossSourceAuditError("CROSS_SOURCE_DATASET_INVALID")
        for instrument_id, trade_date in samples:
            row = db.execute(
                "SELECT d.*, i.board FROM daily_bars d JOIN instruments i USING (instrument_id) "
                "WHERE d.instrument_id = ? AND d.trade_date = ?",
                (instrument_id, trade_date),
            ).fetchone()
            if not row:
                raise CrossSourceAuditError(
                    f"CROSS_SOURCE_CANONICAL_BAR_MISSING:{instrument_id}:{trade_date}"
                )
            canonical = dict(row)
            sources = []
            if instrument_id not in sina_cache:
                try:
                    sina_cache[instrument_id] = sina.bars(instrument_id)
                except (PublicHistoryError, httpx.HTTPError) as exc:
                    sina_cache[instrument_id] = exc
            sina_rows = sina_cache[instrument_id]
            if isinstance(sina_rows, Exception):
                sources.append(
                    {
                        "source": sina.source,
                        "available": False,
                        "reason": type(sina_rows).__name__,
                    }
                )
            else:
                sources.append(_source_result(sina.source, sina_rows, trade_date, canonical))
            try:
                tencent_rows = tencent.bars(instrument_id, trade_date, trade_date)
            except (PublicHistoryError, httpx.HTTPError) as exc:
                sources.append(
                    {
                        "source": tencent.source,
                        "available": False,
                        "reason": type(exc).__name__,
                    }
                )
            else:
                sources.append(
                    _source_result(tencent.source, tencent_rows, trade_date, canonical)
                )

            required_sources = ["SINA"] if canonical["board"] == "BEIJING" else ["SINA", "TENCENT"]
            by_source = {item["source"]: item for item in sources}
            required_passed = all(
                by_source.get(source, {}).get("available")
                and by_source[source].get("matches")
                for source in required_sources
            )
            available_passed = all(
                not item["available"] or item.get("matches") for item in sources
            )
            results.append(
                {
                    "instrumentId": instrument_id,
                    "board": canonical["board"],
                    "tradeDate": trade_date,
                    "canonicalSource": canonical["source"],
                    "canonicalSourceRowSha256": canonical["source_row_sha256"],
                    "requiredSources": required_sources,
                    "sources": sources,
                    "passed": required_passed and available_passed,
                }
            )

    report = {
        "schemaVersion": "market-cross-source-audit.v1",
        "datasetId": metadata["dataset_id"],
        "datasetSchemaVersion": metadata["schema_version"],
        "canonicalSource": metadata["source"],
        "observedAt": observed,
        "priceFieldsCompared": list(PRICE_FIELDS),
        "volumeToleranceSharesExclusive": format(VOLUME_TOLERANCE_SHARES, "f"),
        "samples": results,
        "summary": {
            "samples": len(results),
            "passed": sum(item["passed"] for item in results),
            "failed": sum(not item["passed"] for item in results),
            "boards": sorted({item["board"] for item in results}),
        },
        "passed": all(item["passed"] for item in results),
    }
    report["reportSha256"] = canonical_sha256(report)
    return report
