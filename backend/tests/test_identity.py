import secrets
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, update

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.entrypoints.api import app
from platform_app.modules.identity.models import LoginAttempt, LoginSession, User
from platform_app.modules.identity.service import create_user, token_hash


@pytest.fixture
def identity():
    name, password = "test-" + new_id(), secrets.token_urlsafe(20)
    user_id = create_user(name, password)
    yield name, password, user_id
    with sessions().begin() as db:
        db.execute(delete(LoginSession).where(LoginSession.user_id == user_id))
        db.execute(delete(User).where(User.id == user_id))
        db.execute(delete(LoginAttempt).where(
            LoginAttempt.source_hash == token_hash("testclient"),
        ))


def test_session_origin_logout_and_expiration(identity):
    name, password, user_id = identity
    with TestClient(app) as client:
        assert client.get("/api/v1/sessions/current").status_code == 401
        payload = {"username": name, "password": password}
        assert client.post("/api/v1/sessions", json=payload).status_code == 403
        client.headers["Origin"] = "http://localhost:5173"
        response = client.post("/api/v1/sessions", json=payload)
        assert response.status_code == 200
        assert response.headers["x-frame-options"] == "DENY"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert "frame-ancestors 'none'" in response.headers[
            "content-security-policy"
        ]
        assert response.headers["permissions-policy"] == (
            "camera=(), microphone=(), geolocation=()"
        )
        assert "HttpOnly" in response.headers["set-cookie"]
        assert "SameSite=strict" in response.headers["set-cookie"]
        assert response.json()["data"]["id"] == user_id
        assert password not in response.text
        assert client.get("/api/v1/sessions/current").status_code == 200
        assert client.delete("/api/v1/sessions/current").status_code == 204
        assert client.get("/api/v1/sessions/current").status_code == 401
        client.post("/api/v1/sessions", json=payload)
        with sessions().begin() as db:
            db.execute(update(LoginSession).where(LoginSession.user_id == user_id).values(
                expires_at=utcnow() - timedelta(seconds=1),
            ))
        assert client.get("/api/v1/sessions/current").status_code == 401


def test_login_throttles_and_does_not_echo_credentials(identity):
    name, password, _ = identity
    with TestClient(app) as client:
        client.headers["Origin"] = "http://localhost:5173"
        for _ in range(10):
            response = client.post("/api/v1/sessions", json={
                "username": name, "password": password + "bad",
            })
            assert response.status_code == 401
            assert password not in response.text
        assert client.post("/api/v1/sessions", json={
            "username": name, "password": password,
        }).status_code == 429
