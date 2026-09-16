import json
import sqlite3
from datetime import UTC, datetime

import pytest

from platform_app.modules.experiments import forward_cohort_settlement as settlement


@pytest.mark.parametrize("case", ["pending", "mature", "missing", "tamper"])
def test_future_labels_are_time_gated_and_bound_to_frozen_input(tmp_path, monkeypatch, case):
    root = tmp_path / "capture"
    stock = root / "SH.600000"
    stock.mkdir(parents=True)
    dates = ["20260917", "20260918", "20260921", "20260922", "20260923"]
    (root / "quant-inputs.npz").write_bytes(b"synthetic")
    for name in ("assessment", "input"):
        (stock / f"{name}.json").write_text("{}")
    cohort = {
        "selected": [{"instrumentId": "SH.600000"}], "outcomeSessions": dates,
        "quantInputsSha256": settlement._file_sha256(root / "quant-inputs.npz"),
    }
    (root / "cohort.json").write_text(json.dumps(cohort))
    sample = {
        "instrumentId": "SH.600000", "status": "PENDING", "matureReturnLabels": False,
        "cohortSha256": settlement._file_sha256(root / "cohort.json"),
        **{f"{name}Sha256": settlement._file_sha256(stock / f"{name}.json")
           for name in ("assessment", "input")},
    }
    (root / "report.json").write_text(json.dumps({"samples": [sample]}))
    if case == "tamper":
        (stock / "input.json").write_text('{"changed":true}')
    market_path = tmp_path / "market.sqlite3"
    with sqlite3.connect(market_path) as db:
        db.executescript("""
            CREATE TABLE daily_bars (instrument_id TEXT,trade_date TEXT,open TEXT,
                                     close TEXT,available_at TEXT);
            CREATE TABLE adjustment_factors (instrument_id TEXT,trade_date TEXT,
                                             factor TEXT,available_at TEXT);
        """)
        for date in dates if case != "missing" else dates[:-1]:
            available = f"{date[:4]}-{date[4:6]}-{date[6:]}T16:30:00+08:00"
            db.execute("INSERT INTO daily_bars VALUES ('SH.600000',?,'10','11',?)",
                       (date, available))
            db.execute("INSERT INTO adjustment_factors VALUES ('SH.600000',?,'1',?)",
                       (date, available))
    monkeypatch.setattr(settlement, "_verified_database", lambda *_: ({}, market_path))
    now = datetime(2026, 9, 17 if case == "pending" else 24, tzinfo=UTC)
    output = tmp_path / "outcomes.json"
    if case == "tamper":
        with pytest.raises(ValueError, match="FORWARD_AGENT_INPUT_CHANGED"):
            settlement.settle(root, tmp_path, output, as_of=now)
        assert not output.exists()
        return
    report = settlement.settle(root, tmp_path, output, as_of=now)
    result = report["samples"][0]
    if case == "mature":
        assert result["status"] == "MATURED"
        assert result["adjustedGrossReturn"] == "0.1"
    else:
        assert result["status"] == "PENDING"
        assert "adjustedGrossReturn" not in result
    assert not report["jointPerformanceValidated"]
    assert report["releaseStatus"] == "UNAVAILABLE"
    assert json.loads((root / "report.json").read_text())["samples"][0]["status"] == "PENDING"
