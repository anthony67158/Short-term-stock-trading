from types import SimpleNamespace

import numpy as np
from sqlalchemy import delete

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.decisions import candidates, service
from platform_app.modules.decisions.candidate_contracts import (
    CandidateScan,
    CandidateScanInput,
)
from platform_app.modules.decisions.position_contracts import (
    JointReleaseReference,
)
from platform_app.modules.operations.models import Job, Outbox


def test_candidate_merge_keeps_model_and_agent_recall_separate():
    rows = [
        {"instrument_id": "SZ.000001", "board": "MAIN"},
        {"instrument_id": "SH.600000", "board": "MAIN"},
        {"instrument_id": "BJ.430017", "board": "BEIJING"},
    ]
    agent_events = {
        "BJ.430017": (
            SimpleNamespace(id="assessment-1"),
            SimpleNamespace(thesis_status="SUPPORTED"),
            ["evidence-1"],
        )
    }
    result = candidates._merge_candidates(
        rows,
        np.asarray([0.9, 0.8, 0.1]),
        np.asarray([0.03, 0.02, 0.01]),
        agent_events,
        {"SZ.000001": "甲", "SH.600000": "乙", "BJ.430017": "丙"},
        "20260915",
        2,
    )
    assert [item.instrument_id for item in result] == [
        "SZ.000001",
        "SH.600000",
        "BJ.430017",
    ]
    assert result[0].recall_sources == ["MODEL"]
    assert result[2].recall_sources == ["AGENT_EVENT"]
    assert result[2].assessment_id == "assessment-1"


def test_candidate_scan_job_is_durable_and_idempotent(monkeypatch):
    owner = new_id()
    release = JointReleaseReference(
        release_id="joint-shadow-test",
        status="SHADOW",
        ranking_model_bundle_id="ranking-v1",
        ranking_model_artifact_sha256="a" * 64,
        quant_model_bundle_id="quant-v1",
        quant_model_artifact_sha256="b" * 64,
        position_model_bundle_id="position-v1",
        position_model_artifact_sha256="c" * 64,
        agent_protocol_version="position-assessment.v1",
        blocker_codes=["JOINT_ABLATION_PENDING"],
    )
    scan = CandidateScan(
        release_id=release.release_id,
        release_status="SHADOW",
        as_of=utcnow(),
        decision_date="20260915",
        market_snapshot_ref="market-v1:20260915:" + "d" * 64,
        eligible_instruments=3,
        model_recall_count=2,
        agent_event_recall_count=1,
        candidates=[],
        blocker_codes=release.blocker_codes,
    )
    monkeypatch.setattr(service, "active_release", lambda: release)
    monkeypatch.setattr(
        candidates,
        "build_candidate_scan",
        lambda *_args, **_kwargs: scan,
    )
    key = new_id()
    try:
        first = candidates.submit_scan(
            owner,
            CandidateScanInput(limit=20),
            key,
        )
        duplicate = candidates.submit_scan(
            owner,
            CandidateScanInput(limit=20),
            key,
        )
        assert duplicate.id == first.id
        assert candidates.process_one()
        latest = candidates.latest_scan(owner)
        assert latest.release_id == "joint-shadow-test"
        assert latest.eligible_instruments == 3
    finally:
        with sessions().begin() as db:
            db.execute(delete(Outbox).where(Outbox.owner_id == owner))
            db.execute(delete(Job).where(Job.owner_id == owner))
