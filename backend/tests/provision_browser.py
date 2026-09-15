"""Test harness subprocess protocol. Credentials go only to the parent pipe."""
import json
import secrets
import sys
from urllib.parse import urlsplit

from sqlalchemy import delete, select

from platform_app.adapters.database import sessions
from platform_app.config import settings
from platform_app.contracts.base import new_id
from platform_app.modules.identity.models import LoginSession, User
from platform_app.modules.identity.service import create_user
from platform_app.modules.operations.models import Outbox
from platform_app.modules.portfolio.models import Account, CashEntry

config = settings()
if config.environment not in ("local", "test") or urlsplit(
    config.database_url.get_secret_value(),
).hostname not in ("localhost", "127.0.0.1"):
    raise SystemExit("Browser fixtures require a local database")

if len(sys.argv) == 1:
    username = "browser-fixture-" + new_id()
    password = secrets.token_urlsafe(24)
    user_id = create_user(username, password)
    print(json.dumps({"username": username, "password": password, "userId": user_id}))
else:
    with sessions().begin() as db:
        user = db.get(User, sys.argv[1])
        if not user or not user.username.startswith("browser-fixture-"):
            raise SystemExit("Refusing to remove a non-fixture user")
        account_ids = select(Account.id).where(Account.owner_id == user.id)
        db.execute(delete(CashEntry).where(CashEntry.account_id.in_(account_ids)))
        db.execute(delete(Account).where(Account.owner_id == user.id))
        db.execute(delete(Outbox).where(Outbox.owner_id == user.id))
        db.execute(delete(LoginSession).where(LoginSession.user_id == user.id))
        db.delete(user)
