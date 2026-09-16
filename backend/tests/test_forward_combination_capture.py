import asyncio
import json
import sqlite3
from datetime import UTC, datetime

import numpy as np
import pytest

from platform_app.modules.experiments import forward_combination_capture as forward
from platform_app.modules.experiments.ranking_combination import CANDIDATES
from platform_app.modules.experiments.ranking_model_trainer import MODEL_FEATURE_NAMES


def setup_cohort(tmp_path, monkeypatch, *, latest="20260916"):
    market_path = tmp_path / "market.sqlite3"
    with sqlite3.connect(market_path) as db:
        db.executescript("""
            CREATE TABLE trade_calendar (exchange TEXT,cal_date TEXT,is_open INTEGER);
            CREATE TABLE daily_bars (trade_date TEXT);
            CREATE TABLE instruments (instrument_id TEXT,name TEXT);
        """)
        db.executemany("INSERT INTO trade_calendar VALUES ('SSE',?,1)", [
            (d,) for d in ("20260916", "20260917", "20260918", "20260921",
                          "20260922", "20260923", "20260924")
        ])
        db.execute("INSERT INTO daily_bars VALUES (?)", (latest,))
        db.executemany("INSERT INTO instruments VALUES (?,?)",
                       [(str(i), "Synthetic") for i in range(4)])
    now = datetime(2026, 9, 17, 0, 0, tzinfo=UTC)
    monkeypatch.setattr(forward, "utcnow", lambda: now)
    monkeypatch.setattr(forward, "_verified_database", lambda *_: ({}, market_path))
    rows = [{"instrument_id": str(i), "board": b} for i, b in enumerate(
        ("MAIN", "CHINEXT", "STAR", "BEIJING"))]
    monkeypatch.setattr(forward, "_current_feature_rows", lambda *_: (
        rows, {str(i): "10" for i in range(4)}, {str(i): now for i in range(4)}, "20260923",
    ))
    monkeypatch.setattr(forward, "_date_features", lambda *_: (np.ones((4, 31)), None))

    class Model:
        def predict(self, x):
            return np.arange(len(x))

    monkeypatch.setattr(forward.joblib, "load", lambda *_: Model())
    experiment = tmp_path / "experiment"
    fold = experiment / "fold-5"
    fold.mkdir(parents=True)
    (experiment / "protocol.json").write_text(json.dumps({
        "featureNames": list(MODEL_FEATURE_NAMES), "sourceHashes": {
            "ranking_combination.py": forward._file_sha256(
                forward.Path(forward.__file__).with_name("ranking_combination.py")),
        },
    }))
    (experiment / "splits.json").write_text(json.dumps({"folds": [{
        "fold": 5, "trainEnd": "20250916", "testEnd": "20260908",
    }]}))
    (fold / "evaluation.json").write_text(json.dumps({
        "weights": dict.fromkeys(CANDIDATES, .25),
    }))
    for name in CANDIDATES:
        path = fold / f"{name}.joblib"
        path.write_bytes(b"synthetic")
        path.with_suffix(".json").write_text(json.dumps({
            "modelSha256": forward._file_sha256(path), "trainEnd": 20250916,
        }))
    return experiment, market_path


@pytest.mark.parametrize("policy", ["board-pilot", "candidate-union"])
def test_freeze_binds_full_universe_and_future_entry(tmp_path, monkeypatch, policy):
    experiment, market = setup_cohort(tmp_path, monkeypatch)
    root = tmp_path / "capture"
    cohort = forward.freeze(experiment, market.parent, root, cohort_policy=policy)
    assert cohort["outcomeSessions"] == [
        "20260917", "20260918", "20260921", "20260922", "20260923",
    ]
    assert len(cohort["selected"]) == 4
    assert cohort["cohortPolicy"] == policy
    if policy == "candidate-union":
        assert all("rank5" in s["selectedBy"] and "temporal" in s["selectedBy"]
                   for s in cohort["selected"])
    assert cohort["quantInputsSha256"] == forward._file_sha256(root / "quant-inputs.npz")
    assert cohort["productionReady"] is False
    with pytest.raises(FileExistsError):
        forward.freeze(experiment, market.parent, root)


@pytest.mark.parametrize("fault", ["stale", "hash", "overlap"])
def test_rejects_invalid_forward_lineage_before_capture(tmp_path, monkeypatch, fault):
    experiment, market = setup_cohort(
        tmp_path, monkeypatch, latest="20260915" if fault == "stale" else "20260916",
    )
    if fault == "hash":
        (experiment / "fold-5/rank5.joblib").write_bytes(b"changed")
    if fault == "overlap":
        path = experiment / "splits.json"
        value = json.loads(path.read_text())
        value["folds"][0]["testEnd"] = "20260917"
        path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="FORWARD_"):
        forward.freeze(experiment, market.parent, tmp_path / "capture")
    assert not (tmp_path / "capture").exists()


@pytest.mark.parametrize("fault", [None, "failure", "late", "expired"])
def test_pair_retains_failures_and_checks_entry_validity(tmp_path, monkeypatch, fault):
    root = tmp_path / "paired"
    root.mkdir()
    frozen = {
        "schemaVersion": "synthetic", "outcomeEntryDeadline": "2026-09-17T09:30:00+08:00",
        "selected": [{"instrumentId": "SH.600000", "name": "Synthetic"}],
    }
    (root / "cohort.json").write_text(json.dumps(frozen))
    monkeypatch.setattr(forward, "freeze", lambda *_, **__: frozen)
    monkeypatch.setattr(forward, "encode_agent_assessment", lambda _: {"thesisUncertain": 1})

    async def capture(path, *_):
        path.mkdir()
        if fault != "failure":
            (path / "assessment.json").write_text(json.dumps({
                "valid_until": "2026-09-17T01:00:00+00:00" if fault == "expired"
                else "2026-09-18T01:00:00+00:00",
            }))
            (path / "input.json").write_text("{}")
        return {
            "status": "FAILED" if fault == "failure" else "VALIDATED",
            "errorCode": "UNSUPPORTED_OBSERVATION" if fault == "failure" else None,
            "completedAt": "2026-09-17T02:00:00+00:00" if fault == "late"
            else "2026-09-17T00:00:00+00:00",
        }

    monkeypatch.setattr(forward, "capture", capture)
    report = asyncio.run(forward.run(tmp_path, tmp_path, root))
    sample = report["samples"][0]
    assert sample["status"] == ("EXCLUDED" if fault else "PENDING")
    assert ("agentFeatures" in sample) == (fault is None)
    assert report["matureSamples"] == 0
    assert report["jointPerformanceValidated"] is False
    assert (root / "SH.600000/paired-sample.json").exists()
