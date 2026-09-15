import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.entrypoints.api import app
from platform_app.modules.identity.models import User
from platform_app.modules.identity.routes import current_user
from platform_app.modules.identity.service import create_user
from platform_app.modules.operations.models import Outbox
from platform_app.modules.portfolio import service
from platform_app.modules.portfolio.contracts import AccountInput, CashFlowInput
from platform_app.modules.portfolio.models import Account, CashEntry


@pytest.fixture
def owner():
    user_id = create_user("ledger-test-" + new_id(), secrets.token_urlsafe(24))
    yield user_id
    with sessions().begin() as db:
        ids = db.query(Account.id).filter(Account.owner_id == user_id)
        db.execute(delete(CashEntry).where(CashEntry.account_id.in_(ids)))
        db.execute(delete(Account).where(Account.owner_id == user_id))
        db.execute(delete(Outbox).where(Outbox.owner_id == user_id))
        db.execute(delete(User).where(User.id == user_id))


def make_account(owner):
    return service.create_account(owner, AccountInput(
        name="合成测试账户", kind="SIMULATED", max_position_percent=20,
    ), new_id())


def cash(amount="1000.00", version=1, kind="DEPOSIT"):
    return CashFlowInput(
        kind=kind, amount=amount, expected_version=version,
        effective_at=utcnow() - timedelta(seconds=1), source="合成验收凭据",
    )


def test_cash_exact_idempotent_concurrent_and_cross_owner(owner):
    account = make_account(owner)
    body, key = cash("1000.01"), new_id()
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(
            lambda _: service.record_cash(owner, account.id, body, key), range(4),
        ))
    assert len({result.id for result in results}) == 1
    assert service.balance(owner, account.id).cash_balance == Decimal("1000.01")
    with pytest.raises(service.PortfolioError, match="内容发生变化"):
        service.record_cash(owner, account.id, cash("2000"), key)
    with pytest.raises(service.PortfolioError, match="已有新记录"):
        service.record_cash(owner, account.id, cash(), new_id())
    with pytest.raises(service.PortfolioError) as error:
        service.balance(new_id(), account.id)
    assert error.value.status == 404
    service.record_cash(owner, account.id, cash("0.02", 2, "WITHDRAWAL"), new_id())
    assert service.balance(owner, account.id).cash_balance == Decimal("999.99")
    with pytest.raises(service.PortfolioError, match="超过现金余额"):
        service.record_cash(owner, account.id, cash("1000", 3, "WITHDRAWAL"), new_id())
    assert service.balance(owner, account.id).account.version == 3
    first = service.cash_history(owner, account.id, None, 1)
    second = service.cash_history(owner, account.id, int(first.next_cursor), 1)
    assert first.entries[0].kind == "WITHDRAWAL"
    assert second.entries[0].id == results[0].id
    assert second.next_cursor is None


def test_cash_api_validation_and_immutable_account_creation(owner):
    app.dependency_overrides[current_user] = lambda: User(id=owner)
    try:
        with TestClient(app, headers={"Origin": "http://localhost:5173"}) as client:
            body = {"name": "模拟组合", "kind": "SIMULATED", "maxPositionPercent": 25}
            headers = {"Idempotency-Key": new_id()}
            account = client.post("/api/v1/accounts", json=body, headers=headers).json()["data"]
            url = f"/api/v1/accounts/{account['id']}/cash-flows"
            data = cash().model_dump(mode="json", by_alias=True)
            assert client.post(url, json=data).status_code == 422
            data["amount"] = 1000.1
            assert client.post(url, json=data, headers=headers).status_code == 422
            data["amount"] = "not-a-number"
            assert client.post(url, json=data, headers=headers).status_code == 422
            data["amount"] = "1000.10"
            assert client.post(url, json=data, headers=headers).status_code == 201
            repeated = client.post("/api/v1/accounts", json=body, headers=headers).json()["data"]
            assert repeated == account
            data["kind"] = "OPENING"
            data["expectedVersion"] = 2
            assert client.post(url, json=data, headers={
                "Idempotency-Key": new_id(),
            }).status_code == 409
            data["kind"] = "DEPOSIT"
            data["effectiveAt"] = (utcnow() + timedelta(days=1)).isoformat()
            assert client.post(url, json=data, headers={
                "Idempotency-Key": new_id(),
            }).status_code == 422
    finally:
        app.dependency_overrides.clear()
