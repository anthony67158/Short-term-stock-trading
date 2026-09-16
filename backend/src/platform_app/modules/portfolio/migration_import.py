"""Atomic migration of sourced current-state snapshots into opening facts."""

import hashlib
import json
from datetime import date
from pathlib import Path
from typing import Literal

from pydantic import AwareDatetime, Field, model_validator
from sqlalchemy import func, select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import (
    Contract,
    InstrumentId,
    Money,
    Quantity,
    utcnow,
)
from platform_app.modules.identity.models import User
from platform_app.kernel.trading import trading_date
from platform_app.modules.market.models import Instrument
from platform_app.modules.portfolio.contracts import AccountView
from platform_app.modules.portfolio.models import (
    Account,
    CashEntry,
    OpeningLot,
    PositionLot,
)
from platform_app.modules.portfolio.reconciliation import reconcile


class MigrationError(ValueError):
    pass


class MigrationPosition(Contract):
    source_object_id: str = Field(min_length=1, max_length=128)
    instrument_id: InstrumentId
    quantity_shares: Quantity = Field(gt=0)
    cost_basis: Money = Field(ge=0)
    acquired_date: date


class MigrationAccount(Contract):
    source_object_id: str = Field(min_length=1, max_length=128)
    source_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    name: str = Field(min_length=1, max_length=80)
    kind: Literal["REAL", "SIMULATED"]
    max_position_percent: int = Field(strict=True, ge=1, le=100)
    cash_balance: Money = Field(ge=0)
    effective_at: AwareDatetime
    positions: list[MigrationPosition] = Field(max_length=10_000)
    performance_reconstructable: Literal[False] = False

    @model_validator(mode="after")
    def unique_sources(self):
        sources = [
            position.source_object_id for position in self.positions
        ]
        if len(sources) != len(set(sources)):
            raise ValueError("持仓来源编号重复")
        return self


class MigrationSnapshot(Contract):
    schema_version: Literal["legacy-current-state.v1"]
    migration_run_id: str = Field(
        min_length=1,
        max_length=80,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )
    owner_username: str = Field(min_length=1, max_length=80)
    accounts: list[MigrationAccount] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_accounts(self):
        sources = [
            account.source_object_id for account in self.accounts
        ]
        if len(sources) != len(set(sources)):
            raise ValueError("账户来源编号重复")
        return self


def _canonical_hash(account: MigrationAccount) -> str:
    payload = account.model_dump(
        mode="json",
        exclude={"source_hash"},
    )
    return hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def load_snapshot(path: Path) -> MigrationSnapshot:
    try:
        raw = json.loads(path.expanduser().resolve().read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise MigrationError("MIGRATION_SNAPSHOT_INVALID") from exc
    try:
        snapshot = MigrationSnapshot.model_validate(raw)
    except ValueError as exc:
        raise MigrationError("MIGRATION_SNAPSHOT_INVALID") from exc
    if any(
        account.source_hash != _canonical_hash(account)
        for account in snapshot.accounts
    ):
        raise MigrationError("MIGRATION_SOURCE_HASH_MISMATCH")
    return snapshot


def _source(run_id: str, object_id: str) -> str:
    return f"MIGRATION:{run_id}:{object_id}"


def migrate_snapshot(path: Path) -> dict:
    snapshot = load_snapshot(path)
    results = []
    for source_account in snapshot.accounts:
        with sessions().begin() as db:
            owner = db.scalar(
                select(User)
                .where(User.username == snapshot.owner_username)
                .with_for_update()
            )
            if owner is None:
                raise MigrationError("MIGRATION_OWNER_NOT_FOUND")
            missing = set(
                db.scalars(
                    select(Instrument.id).where(
                        Instrument.id.in_(
                            [
                                position.instrument_id
                                for position in source_account.positions
                            ]
                        )
                    )
                )
            )
            expected = {
                position.instrument_id
                for position in source_account.positions
            }
            if missing != expected:
                raise MigrationError(
                    "MIGRATION_INSTRUMENTS_NOT_FOUND"
                )
            creation_key = _source(
                snapshot.migration_run_id,
                source_account.source_object_id,
            )
            existing = db.scalar(
                select(Account).where(
                    Account.owner_id == owner.id,
                    Account.creation_key == creation_key,
                )
            )
            if existing:
                if existing.creation_hash != source_account.source_hash:
                    raise MigrationError(
                        "MIGRATION_IDEMPOTENCY_CONFLICT"
                    )
                account_id = existing.id
                status = "ALREADY_MIGRATED"
            else:
                if source_account.effective_at > utcnow():
                    raise MigrationError(
                        "MIGRATION_EFFECTIVE_TIME_IN_FUTURE"
                    )
                if any(
                    position.acquired_date
                    > trading_date(source_account.effective_at)
                    for position in source_account.positions
                ):
                    raise MigrationError(
                        "MIGRATION_ACQUIRED_DATE_INVALID"
                    )
                account = Account(
                    owner_id=owner.id,
                    name=source_account.name,
                    kind=source_account.kind,
                    currency="CNY",
                    max_position_percent=(
                        source_account.max_position_percent
                    ),
                    version=1,
                    creation_key=creation_key,
                    creation_hash=source_account.source_hash,
                    creation_result={},
                )
                db.add(account)
                db.flush()
                account.creation_result = AccountView.model_validate(
                    account
                ).model_dump(mode="json")
                if source_account.cash_balance > 0:
                    account.version += 1
                    db.add(
                        CashEntry(
                            account_id=account.id,
                            source_key=_source(
                                snapshot.migration_run_id,
                                source_account.source_object_id
                                + ":cash",
                            ),
                            request_hash=source_account.source_hash,
                            kind="OPENING",
                            amount=source_account.cash_balance,
                            source="旧系统当前状态迁移：期初现金",
                            effective_at=source_account.effective_at,
                            account_version=account.version,
                        )
                    )
                for position in source_account.positions:
                    account.version += 1
                    opening = OpeningLot(
                        account_id=account.id,
                        instrument_id=position.instrument_id,
                        quantity_shares=position.quantity_shares,
                        cost_basis=position.cost_basis,
                        acquired_date=position.acquired_date,
                        effective_at=source_account.effective_at,
                        source_key=_source(
                            snapshot.migration_run_id,
                            position.source_object_id,
                        ),
                        source="旧系统当前状态迁移：有来源期初批次",
                        command_key=_source(
                            snapshot.migration_run_id,
                            position.source_object_id,
                        ),
                        request_hash=source_account.source_hash,
                        account_version=account.version,
                    )
                    db.add(opening)
                    db.flush()
                    db.add(
                        PositionLot(
                            id=opening.id,
                            opening_id=opening.id,
                            account_id=account.id,
                            instrument_id=position.instrument_id,
                            acquired_date=position.acquired_date,
                            remaining_quantity=position.quantity_shares,
                            remaining_basis=position.cost_basis,
                            sequence=account.version,
                        )
                    )
                db.flush()
                account_id = account.id
                status = "MIGRATED"
            verification = reconcile(
                owner.id,
                account_id,
                db_session=db,
            )
            if not verification.matches:
                raise MigrationError(
                    "MIGRATION_RECONCILIATION_FAILED"
                )
            quantity = int(
                db.scalar(
                    select(
                        func.coalesce(
                            func.sum(PositionLot.remaining_quantity),
                            0,
                        )
                    ).where(PositionLot.account_id == account_id)
                )
            )
            results.append(
                {
                    "migrationRunId": snapshot.migration_run_id,
                    "sourceObjectId": (
                        source_account.source_object_id
                    ),
                    "sourceHash": source_account.source_hash,
                    "targetId": account_id,
                    "status": status,
                    "cashBalance": format(
                        verification.cash_balance,
                        "f",
                    ),
                    "positionShares": quantity,
                    "reconciliationMatches": True,
                    "performanceReconstructable": False,
                }
            )
    return {
        "schemaVersion": "migration-report.v1",
        "migrationRunId": snapshot.migration_run_id,
        "createdAt": utcnow().isoformat(),
        "sourceSnapshotSha256": hashlib.sha256(
            path.expanduser().resolve().read_bytes()
        ).hexdigest(),
        "accounts": results,
        "limitations": [
            "历史交易明细未提供时只迁移有来源的当前现金和期初批次",
            "不得从当前持仓反推历史成交或历史收益",
        ],
        "passed": all(
            account["reconciliationMatches"] for account in results
        ),
    }
