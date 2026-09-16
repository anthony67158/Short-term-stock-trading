import secrets
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from platform_app.adapters.database import sessions
from platform_app.config import settings
from platform_app.contracts.base import new_id, utcnow
from platform_app.entrypoints.api import app
from platform_app.modules.decisions import service
from platform_app.modules.decisions.models import (
    CurrentDecision,
    DecisionContextRecord,
    DecisionRecord,
)
from platform_app.modules.decisions.position_contracts import (
    ActionValueEstimate,
    JointReleaseReference,
    PositionEvaluationInput,
    PositionValueReference,
)
from platform_app.modules.decisions.position_engine import arbitrate_position
from platform_app.modules.identity.models import User
from platform_app.modules.identity.routes import current_user
from platform_app.modules.identity.service import create_user
from platform_app.modules.market.models import Instrument
from platform_app.modules.learning.models import ProspectiveSample
from platform_app.modules.operations.models import Job, Outbox
from platform_app.modules.portfolio import openings
from platform_app.modules.portfolio.models import Account, OpeningLot, PositionLot
from platform_app.modules.portfolio.opening_contracts import OpeningInput
from platform_app.modules.portfolio.service import create_account
from platform_app.modules.portfolio.contracts import AccountInput
from platform_app.modules.research.models import Assessment, Evidence
from platform_app.modules.decisions.position_runtime import build_position_assessment


@pytest.fixture
def decision_scope(monkeypatch):
    owner = create_user(
        "decision-test-" + new_id(),
        secrets.token_urlsafe(24),
    )
    instrument_id = "SZ.999992"
    with sessions().begin() as db:
        db.add(
            Instrument(
                id=instrument_id,
                code="999992",
                exchange="SZ",
                name="合成决策证券",
                board="MAIN",
                first_seen_at=utcnow(),
                last_seen_at=utcnow(),
                is_current=False,
            )
        )
    account = create_account(
        owner,
        AccountInput(
            name="合成决策账户",
            kind="SIMULATED",
            max_position_percent=20,
        ),
        new_id(),
    )
    opening = openings.record_opening(
        owner,
        account.id,
        OpeningInput(
            instrument_id=instrument_id,
            quantity_shares=1000,
            cost_basis="10000",
            acquired_date=(utcnow() - timedelta(days=2)).date(),
            effective_at=utcnow() - timedelta(days=1),
            source_key="synthetic-decision-opening",
            source="合成决策测试",
            expected_version=account.version,
        ),
        new_id(),
    )
    config = settings().model_copy(update={"joint_bundle_root": None})
    monkeypatch.setattr(service, "settings", lambda: config)
    yield owner, instrument_id, account.id, opening.account_version
    with sessions().begin() as db:
        db.execute(
            delete(CurrentDecision).where(CurrentDecision.account_id == account.id)
        )
        db.execute(
            delete(ProspectiveSample).where(ProspectiveSample.owner_id == owner)
        )
        db.execute(delete(DecisionRecord).where(DecisionRecord.owner_id == owner))
        db.execute(
            delete(DecisionContextRecord).where(
                DecisionContextRecord.owner_id == owner
            )
        )
        db.execute(delete(PositionLot).where(PositionLot.account_id == account.id))
        db.execute(delete(OpeningLot).where(OpeningLot.account_id == account.id))
        db.execute(delete(Assessment).where(Assessment.owner_id == owner))
        db.execute(delete(Evidence).where(Evidence.owner_id == owner))
        db.execute(delete(Job).where(Job.owner_id == owner))
        db.execute(delete(Outbox).where(Outbox.owner_id == owner))
        db.execute(delete(Account).where(Account.id == account.id))
        db.execute(delete(Instrument).where(Instrument.id == instrument_id))
        db.execute(delete(User).where(User.id == owner))


def evaluation(instrument_id, version):
    return PositionEvaluationInput(
        instrument_id=instrument_id,
        expected_version=version,
        reason="合成持仓联合复核",
    )


def test_unreleased_joint_evaluation_is_persisted_as_unavailable(decision_scope):
    owner, instrument_id, account_id, version = decision_scope
    body = evaluation(instrument_id, version)
    key = new_id()
    job = service.submit_position_evaluation(owner, account_id, body, key)
    assert (
        service.submit_position_evaluation(owner, account_id, body, key).id
        == job.id
    )
    assert service.process_one()
    with sessions()() as db:
        finished = db.get(Job, job.id)
        assert finished.status == "SUCCEEDED"
        decision_id = finished.result["decisionId"]
        pointer = db.get(CurrentDecision, (account_id, instrument_id))
        assert pointer.decision_id == decision_id
    decision = service.decision_by_id(owner, decision_id)
    assert decision.status == "UNAVAILABLE"
    assert decision.action == "NONE"
    assert decision.reason_codes == ["JOINT_RELEASE_NOT_CONFIGURED"]
    page = service.current_decisions(owner, account_id, None, 20)
    assert [item.decision_id for item in page.decisions] == [decision_id]
    with pytest.raises(service.DecisionError) as error:
        service.decision_by_id(new_id(), decision_id)
    assert error.value.status == 404


def test_account_change_during_evaluation_prevents_publication(decision_scope):
    owner, instrument_id, account_id, version = decision_scope
    job = service.submit_position_evaluation(
        owner,
        account_id,
        evaluation(instrument_id, version),
        new_id(),
    )
    with sessions().begin() as db:
        account = db.get(Account, account_id)
        account.version += 1
    assert service.process_one()
    with sessions()() as db:
        finished = db.get(Job, job.id)
        assert finished.status == "FAILED"
        assert finished.error_code == "ACCOUNT_VERSION_CONFLICT"
        assert (
            db.scalar(
                select(DecisionRecord).where(DecisionRecord.owner_id == owner)
            )
            is None
        )


def test_position_evaluation_api_does_not_accept_model_values(decision_scope):
    owner, instrument_id, account_id, version = decision_scope
    app.dependency_overrides[current_user] = lambda: User(id=owner)
    try:
        with TestClient(
            app,
            headers={"Origin": "http://localhost:5173"},
        ) as client:
            body = evaluation(instrument_id, version).model_dump(
                mode="json",
                by_alias=True,
            )
            body["quantPrediction"] = {"chosenAction": "ADD"}
            response = client.post(
                f"/api/v1/accounts/{account_id}/evaluations",
                json=body,
                headers={"Idempotency-Key": new_id()},
            )
            assert response.status_code == 422
            body.pop("quantPrediction")
            response = client.post(
                f"/api/v1/accounts/{account_id}/evaluations",
                json=body,
                headers={"Idempotency-Key": new_id()},
            )
            assert response.status_code == 202
            assert response.json()["data"]["status"] == "QUEUED"
    finally:
        app.dependency_overrides.clear()


def test_valid_research_is_normalized_to_audited_position_assessment(
    decision_scope,
    monkeypatch,
):
    owner, instrument_id, account_id, version = decision_scope
    now = utcnow()
    evidence_id = new_id()
    research_job_id = new_id()
    assessment_id = new_id()
    statement = "这是合成测试原文中的可定位事实。"
    with sessions().begin() as db:
        db.add(
            Job(
                id=research_job_id,
                owner_id=owner,
                kind="RESEARCH",
                business_key=new_id(),
                input_hash="a" * 64,
                payload={},
                status="SUCCEEDED",
            )
        )
        db.add(
            Evidence(
                id=evidence_id,
                owner_id=owner,
                instrument_id=instrument_id,
                source_key=new_id(),
                request_hash="b" * 64,
                title="合成持仓证据",
                source_url="https://example.com/position-evidence",
                text=statement + "其余内容用于满足原文长度要求。",
                quote=statement,
                content_hash="c" * 64,
                published_at=now - timedelta(days=1),
                first_seen_at=now - timedelta(hours=2),
                available_at=now - timedelta(hours=2),
                provenance="USER_SUPPLIED",
                validation="QUOTE_MATCHED",
            )
        )
        db.add(
            Assessment(
                id=assessment_id,
                owner_id=owner,
                instrument_id=instrument_id,
                job_id=research_job_id,
                protocol_version="research-assessment.v1",
                model_id="gpt-synthetic",
                as_of=now - timedelta(minutes=5),
                input_hash="d" * 64,
                evidence_ids=[evidence_id],
                output={
                    "summary": "合成持仓研究",
                    "claims": [
                        {
                            "kind": "OBSERVED",
                            "statement": statement,
                            "evidenceIds": [evidence_id],
                        }
                    ],
                    "counterClaims": [],
                    "thesisStatus": "SUPPORTED",
                    "strategyFit": ["QUALITY"],
                    "uncertainties": ["仍需核验实时交易"],
                    "invalidation": "原始证据被撤回",
                    "nextCheck": "复核下一份公告",
                    "validUntil": (now + timedelta(minutes=20)).isoformat(),
                },
                tool_trace=[],
            )
        )
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
        blocker_codes=["PROSPECTIVE_AGENT_SAMPLE_SUPPORT_INSUFFICIENT"],
    )
    monkeypatch.setattr(service, "active_release", lambda: release)
    job = service.submit_position_evaluation(
        owner,
        account_id,
        evaluation(instrument_id, version),
        new_id(),
    )
    request = service.PositionDecisionRequest.model_validate(
        job.payload["request"]
    )
    assessment = build_position_assessment(owner, request)
    assert assessment.assessment_id == assessment_id
    assert assessment.thesis_status == "SUPPORTED"
    assert assessment.signals[0].statement == statement
    assert assessment.signals[0].validation == "UNVERIFIED"
    assert any("主力资金" in item for item in assessment.uncertainties)
    values = []
    for action, target, expected in (
        ("HOLD", 1000, 0.0),
        ("ADD", 2000, 0.02),
        ("REDUCE", 500, -0.01),
        ("EXIT", 0, -0.02),
    ):
        is_hold = action == "HOLD"
        values.append(
            ActionValueEstimate(
                action=action,
                target_quantity_shares=target,
                expected_delta_return_vs_hold=expected,
                q10_delta_return_vs_hold=0 if is_hold else None,
                q50_delta_return_vs_hold=0 if is_hold else None,
                q90_delta_return_vs_hold=0 if is_hold else None,
                missing_prediction_fields=(
                    ["stopHazard", "support"]
                    if is_hold
                    else ["q10", "q50", "q90", "stopHazard", "support"]
                ),
                estimated_costs="0" if is_hold else "5",
                execution_path=None if is_hold else "SHADOW_MARKET_REFERENCE",
                price_lower=None if is_hold else "10",
                price_upper=None if is_hold else "10",
                price_basis=None if is_hold else "SEALED_CLOSE:20260915",
                trigger_conditions=[] if is_hold else ["SHADOW_SIMULATION_ONLY"],
            )
        )
    quant = PositionValueReference(
        model_bundle_id="position-v1",
        model_artifact_sha256="c" * 64,
        feature_schema_version="position-runtime-features.v1",
        context_id=request.context_id,
        account_id=account_id,
        account_version=version,
        instrument_id=instrument_id,
        as_of=request.as_of,
        valid_until=request.valid_until,
        horizon="5_TRADING_DAYS",
        horizon_end_date=(request.as_of + timedelta(days=7)).date(),
        market_snapshot_ref="market-v1:20260915:" + "e" * 64,
        trend="BULLISH",
        current_quantity_shares=1000,
        values=values,
        cost_assumptions_ref="fees-v1",
        calibration_ref="position-v1",
    )
    enriched = request.model_copy(
        update={"quant": quant, "agent": assessment}
    )
    decision = arbitrate_position(enriched)
    assert decision.status == "READY"
    with sessions().begin() as db:
        service._publish(db, db.get(Job, job.id), decision, enriched)
    with sessions()() as db:
        sample = db.scalar(
            select(ProspectiveSample).where(
                ProspectiveSample.owner_id == owner
            )
        )
        assert sample.status == "PENDING"
        assert sample.agent_feature_schema_version == "position-agent-features.v1"
        assert sample.scenario["selectedAction"] == "ADD"
