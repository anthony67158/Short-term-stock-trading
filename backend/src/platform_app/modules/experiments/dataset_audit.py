"""Read-only audit of explicit archived market roots; never load legacy models/code."""
import gzip
import hashlib
import json
import math
import sqlite3
from collections import Counter
from pathlib import Path


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def audit_daily(path, securities=None):
    with gzip.open(path, "rt") as stream:
        rows = json.load(stream)
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"Daily archive must contain nonempty rows: {path.name}")
    dates, codes, keys, bad = Counter(), set(), set(), Counter()
    fields = set()
    for row in rows:
        if not isinstance(row, dict):
            bad["invalidRow"] += 1
            continue
        fields.update(row)
        date, code = str(row.get("date", "")), str(row.get("code", ""))
        key = (date, code)
        if key in keys:
            bad["duplicateDateCode"] += 1
        keys.add(key)
        dates[date] += 1
        codes.add(code)
        if len(code) != 6 or not code.isdigit() or len(date) != 8 or not date.isdigit():
            bad["invalidIdentity"] += 1
        values = [row.get(name) for name in ("open", "high", "low", "close", "volume", "amount")]
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in values):
            bad["nonfiniteMarketValue"] += 1
            continue
        opening, high, low, close, volume, amount = values
        if not 0 < low <= min(opening, close) <= max(opening, close) <= high:
            bad["invalidOHLC"] += 1
        if volume < 0 or amount < 0:
            bad["negativeVolumeOrAmount"] += 1
    return {
        "file": str(path), "sha256": sha256(path), "compressedBytes": path.stat().st_size,
        "rows": len(rows), "dates": len(dates), "from": min(dates), "to": max(dates),
        "securities": len(codes), "minRowsPerDate": min(dates.values()),
        "maxRowsPerDate": max(dates.values()), "fields": sorted(fields),
        "violations": dict(bad),
        "codePrefixes": dict(sorted(Counter(code[:3] for code in codes).items())),
        "knownDelistedSecurities": sum(bool(securities.get(code, {}).get("delist_date"))
                                      for code in codes) if securities is not None else None,
        "codesMissingMetadata": len(codes - securities.keys()) if securities is not None else None,
        "pointInTimeFieldsPresent": all(name in fields for name in (
            "availableAt", "exchange", "listedAt", "delistedAt", "adjustmentFactor")),
    }


def audit_minutes(path):
    if not path.is_file():
        return {"available": False}
    # Read-only connection: no checkpoints, downloads, updates or arbitrary SQL from input.
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5) as db:
        tables = {row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"bars", "completed"} <= tables:
            return {"available": True, "schemaRecognized": False}
        completed, reported_rows, start, end = db.execute(
            "SELECT count(*), sum(rows), min(start_date), max(end_date) FROM completed").fetchone()
        sample = db.execute("SELECT code, date, trade_time FROM bars LIMIT 1").fetchone()
        excluded = dict(db.execute(
            "SELECT reason, count(*) FROM exclusions GROUP BY reason")) if "exclusions" in tables else {}
        return {
            "available": True, "schemaRecognized": True, "bytes": path.stat().st_size,
            "completedSecurities": completed, "downloadReportedRows": reported_rows,
            "downloadFrom": start, "downloadTo": end, "sampleExists": sample is not None,
            "excludedCodeDaysByReason": excluded,
            "coverageVerified": False,
            "limitation": "Download counts do not prove causal-universe or execution coverage.",
        }


def audit_roots(roots: list[Path], securities_file: Path | None = None):
    securities, metadata = None, None
    if securities_file is not None:
        with gzip.open(securities_file, "rt") as stream:
            rows = json.load(stream)
        if not isinstance(rows, list) or not rows:
            raise ValueError("Security metadata must be a nonempty list")
        securities = {row["symbol"]: row for row in rows}
        if len(securities) != len(rows):
            raise ValueError("Security symbols are ambiguous across metadata records")
        metadata = {"sha256": sha256(securities_file), "securities": len(rows),
                    "knownDelisted": sum(bool(row.get("delist_date")) for row in rows),
                    "historicalAvailabilityVerified": False}
    chunks = []
    for root in roots:
        if not root.is_dir():
            raise ValueError(f"Archive root does not exist: {root}")
        for daily in sorted(root.glob("chunk-*/daily.json.gz")):
            chunks.append({
                "root": root.name, "chunk": daily.parent.name,
                "daily": audit_daily(daily, securities),
                "minutes": audit_minutes(daily.parent / "tushare-minute.sqlite3"),
            })
    if not chunks:
        raise ValueError("No chunk daily archives found")
    return {
        "schemaVersion": "market-archive-audit.v1",
        "scope": "ARCHIVE_DISCOVERY_NOT_TRAINING_ACCEPTANCE",
        "chunkCount": len(chunks), "chunks": chunks,
        "rawRowsIncludingOverlappingChunks": sum(chunk["daily"]["rows"] for chunk in chunks),
        "from": min(chunk["daily"]["from"] for chunk in chunks),
        "to": max(chunk["daily"]["to"] for chunk in chunks),
        "productionEligible": False,
        "securityMetadata": metadata,
        "unresolved": [
            "Deduplicate overlapping chunks and reject conflicting bars.",
            "Verify historical listed/delisted identities and risk-warning status.",
            "Verify adjustment/corporate-action factors and unit provenance.",
            "Verify minute coverage against a causal universe, not legacy-selected candidates.",
            "Rebuild labels with new execution policy; do not reuse legacy action labels.",
            "Obtain time-stamped Agent evidence; retrospective reconstruction must be labelled.",
            "Freeze new untouched evaluation periods; previously inspected holdouts are development data.",
        ],
    }
