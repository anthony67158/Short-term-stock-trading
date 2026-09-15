import hashlib
import secrets
from datetime import timedelta

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from sqlalchemy import delete, func, select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import utcnow
from platform_app.modules.identity.models import LoginAttempt, LoginSession, User

hasher = PasswordHasher()
dummy_hash = hasher.hash(secrets.token_urlsafe(32))


class IdentityError(ValueError):
    def __init__(self, code: str, status: int, message: str):
        self.code, self.status, self.message = code, status, message


def token_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def create_user(username: str, password: str) -> str:
    if len(password) < 12 or not 1 <= len(username.strip()) <= 80:
        raise ValueError("用户名必填，密码至少12位")
    with sessions().begin() as db:
        user = User(username=username.strip(), password_hash=hasher.hash(password))
        db.add(user)
        db.flush()
        return user.id


def login(username: str, password: str, source: str) -> tuple[User, str]:
    now = utcnow()
    source_key = token_hash(source)
    with sessions().begin() as db:
        # Serialize rate checks for one peer across API processes.
        db.execute(select(func.pg_advisory_xact_lock(
            int(source_key[:15], 16),
        )))
        db.execute(delete(LoginAttempt).where(
            LoginAttempt.created_at < now - timedelta(minutes=15),
        ))
        count = db.scalar(select(func.count()).select_from(LoginAttempt).where(
            LoginAttempt.source_hash == source_key,
        ))
        if count >= 10:
            raise IdentityError("RATE_LIMITED", 429, "尝试次数过多，请15分钟后再试")
        db.add(LoginAttempt(source_hash=source_key))
    with sessions().begin() as db:
        user = db.scalar(select(User).where(User.username == username.strip()))
        try:
            valid = hasher.verify(user.password_hash if user else dummy_hash, password)
        except VerificationError:
            valid = False
        if not user or not valid:
            raise IdentityError("INVALID_CREDENTIALS", 401, "用户名或密码不正确")
        token = secrets.token_urlsafe(32)
        db.add(LoginSession(
            token_hash=token_hash(token), user_id=user.id,
            expires_at=now + timedelta(hours=12),
        ))
        return user, token


def authenticate(token: str | None) -> User:
    if token:
        with sessions()() as db:
            user = db.scalar(select(User).join(LoginSession).where(
                LoginSession.token_hash == token_hash(token),
                LoginSession.expires_at > utcnow(),
            ))
            if user:
                return user
    raise IdentityError("UNAUTHENTICATED", 401, "请先登录")


def logout(token: str):
    with sessions().begin() as db:
        db.execute(delete(LoginSession).where(LoginSession.token_hash == token_hash(token)))
