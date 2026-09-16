import secrets
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import delete, func, select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.identity.models import User
from platform_app.modules.identity.service import create_user
from platform_app.modules.market.models import Instrument
from platform_app.modules.portfolio.migration_import import (
    MigrationAccount,
    MigrationSnapshot,
    _canonical_hash,
    migrate_snapshot,
)
from platform_app.modules.portfolio.models import (
    Account,
    CashEntry,
    OpeningLot,
    PositionLot,
)


def test_current_state_migration_is_account_atomic_and_idempotent(
    tmp_path,
):
    username = "migration-" + new_id()
    owner_id = create_user(username, secrets.token_urlsafe(24))
    instrument_id = "SZ.999989"
    with sessions().begin() as db:
        db.add(
            Instrument(
                id=instrument_id,
                code="999989",
                exchange="SZ",
                name="合成迁移证券",
                board="MAIN",
                first_seen_at=utcnow(),
                last_seen_at=utcnow(),
                is_current=False,
            )
        )
    account = MigrationAccount(
        source_object_id="legacy-account-1",
        source_hash="0" * 64,
        name="迁移实盘账户",
        kind="REAL",
        max_position_percent=20,
        cash_balance="12345.67",
        effective_at=utcnow() - timedelta(days=1),
        positions=[
            {
                "sourceObjectId": "legacy-position-1",
                "instrumentId": instrument_id,
                "quantityShares": 300,
                "costBasis": "3456.78",
                "acquiredDate": (
                    utcnow() - timedelta(days=10)
                ).date(),
            }
        ],
        performance_reconstructable=False,
    )
    account = account.model_copy(
        update={"source_hash": _canonical_hash(account)}
    )
    snapshot = MigrationSnapshot(
        schema_version="legacy-current-state.v1",
        migration_run_id="migration-test-v1",
        owner_username=username,
        accounts=[account],
    )
    path = tmp_path / "snapshot.json"
    path.write_text(
        snapshot.model_dump_json(by_alias=True),
    )

    first = migrate_snapshot(path)
    second = migrate_snapshot(path)

    assert first["passed"] is True
    assert first["accounts"][0]["status"] == "MIGRATED"
    assert second["accounts"][0]["status"] == "ALREADY_MIGRATED"
    assert first["accounts"][0]["targetId"] == second["accounts"][0][
        "targetId"
    ]
    with sessions()() as db:
        migrated = db.scalar(
            select(Account).where(
                Account.owner_id == owner_id,
                Account.creation_key
                == "MIGRATION:migration-test-v1:legacy-account-1",
            )
        )
        assert migrated.version == 3
        assert db.scalar(
            select(func.sum(CashEntry.amount)).where(
                CashEntry.account_id == migrated.id
            )
        ) == Decimal("12345.67")
        lot = db.scalar(
            select(PositionLot).where(
                PositionLot.account_id == migrated.id
            )
        )
        assert lot.remaining_quantity == 300
        assert lot.remaining_basis == Decimal("3456.78")
    with sessions().begin() as db:
        account_ids = select(Account.id).where(
            Account.owner_id == owner_id
        )
        db.execute(
            delete(PositionLot).where(
                PositionLot.account_id.in_(account_ids)
            )
        )
        db.execute(
            delete(OpeningLot).where(
                OpeningLot.account_id.in_(account_ids)
            )
        )
        db.execute(
            delete(CashEntry).where(
                CashEntry.account_id.in_(account_ids)
            )
        )
        db.execute(
            delete(Account).where(Account.owner_id == owner_id)
        )
        db.execute(
            delete(Instrument).where(Instrument.id == instrument_id)
        )
        db.execute(delete(User).where(User.id == owner_id))
