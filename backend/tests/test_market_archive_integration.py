import gzip
import json
import sqlite3

from platform_app.modules.experiments.dataset_audit import audit_roots


def test_archive_inspection_preserves_sources_and_reports_bad_rows(tmp_path):
    chunk = tmp_path / "chunk-01"
    chunk.mkdir()
    bar = {"code": "000001", "date": "20260914", "open": 10, "high": 12,
           "low": 9, "close": 11, "volume": 100, "amount": 1000}
    daily = chunk / "daily.json.gz"
    with gzip.open(daily, "wt") as stream:
        json.dump([bar, bar, {**bar, "date": "20260915", "close": 20}], stream)
    before = daily.read_bytes()
    path = chunk / "tushare-minute.sqlite3"
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE bars(code TEXT, date TEXT, trade_time TEXT)")
        db.execute("CREATE TABLE completed(code TEXT, rows INTEGER, start_date TEXT, end_date TEXT)")
        db.execute("INSERT INTO completed VALUES('000001',10,'20260914','20260915')")
    metadata = tmp_path / "securities.json.gz"
    with gzip.open(metadata, "wt") as stream:
        json.dump([{"symbol": "000001", "delist_date": "20260916"}], stream)
    report = audit_roots([tmp_path], metadata)
    assert report["rawRowsIncludingOverlappingChunks"] == 3
    result = report["chunks"][0]
    assert result["daily"]["violations"] == {"duplicateDateCode": 1, "invalidOHLC": 1}
    assert not result["daily"]["pointInTimeFieldsPresent"]
    assert result["daily"]["knownDelistedSecurities"] == 1
    assert report["securityMetadata"]["knownDelisted"] == 1
    assert result["minutes"]["downloadReportedRows"] == 10
    assert not result["minutes"]["coverageVerified"] and not result["minutes"]["sampleExists"]
    assert report["productionEligible"] is False and daily.read_bytes() == before
