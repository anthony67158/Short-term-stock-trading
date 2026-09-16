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
from platform_app.modules.decisions.position_contracts import PositionEvaluationInput
from platform_app.modules.identity.models import User
from platform_app.modules.identity.routes import current_user
from platform_app.modules.identity.service import create_user
from platform_app.modules.market.models import Instrument
from platform_app.modules.operations.models import Job, Outbox
from platform_app.modules.portfolio import openings
from platform_app.modules.portfolio.models import Account, OpeningLot, PositionLot
from platform_app.modules.portfolio.opening_contracts import OpeningInput
from platform_app.modules.portfolio.service import create_account
from platform_app.modules.portfolio.contracts import AccountInput


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
        db.execute(delete(DecisionRecord).where(DecisionRecord.owner_id == owner))
        db.execute(
            delete(DecisionContextRecord).where(
                DecisionContextRecord.owner_id == owner
            )
        )
        db.execute(delete(PositionLot).where(PositionLot.account_id == account.id))
        db.execute(delete(OpeningLot).where(OpeningLot.account_id == account.id))
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
