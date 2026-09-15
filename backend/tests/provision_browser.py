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
from platform_app.modules.operations.models import Job, Outbox
from platform_app.modules.market.models import Watch
from platform_app.modules.portfolio.models import (
    Account, CashEntry, Execution, ExecutionCommand, ExecutionCorrection, ExecutionImport,
    ExecutionPlan, LotConsumption, PlanEvent, PositionLot,
)
from platform_app.modules.research.models import Assessment, Evidence

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
        execution_ids = select(Execution.id).where(Execution.account_id.in_(account_ids))
        db.execute(delete(LotConsumption).where(
            LotConsumption.sell_execution_id.in_(execution_ids)))
        db.execute(delete(PositionLot).where(PositionLot.account_id.in_(account_ids)))
        db.execute(delete(ExecutionCommand).where(ExecutionCommand.account_id.in_(account_ids)))
        db.execute(delete(CashEntry).where(CashEntry.account_id.in_(account_ids)))
        db.execute(delete(ExecutionCorrection).where(ExecutionCorrection.account_id.in_(account_ids)))
        db.execute(delete(Execution).where(Execution.account_id.in_(account_ids)))
        db.execute(delete(ExecutionImport).where(ExecutionImport.account_id.in_(account_ids)))
        db.execute(delete(PlanEvent).where(PlanEvent.account_id.in_(account_ids)))
        db.execute(delete(ExecutionPlan).where(ExecutionPlan.account_id.in_(account_ids)))
        db.execute(delete(Account).where(Account.owner_id == user.id))
        db.execute(delete(Outbox).where(Outbox.owner_id == user.id))
        db.execute(delete(Watch).where(Watch.owner_id == user.id))
        db.execute(delete(Assessment).where(Assessment.owner_id == user.id))
        db.execute(delete(Evidence).where(Evidence.owner_id == user.id))
        db.execute(delete(Job).where(Job.owner_id == user.id))
        db.execute(delete(LoginSession).where(LoginSession.user_id == user.id))
        db.delete(user)
