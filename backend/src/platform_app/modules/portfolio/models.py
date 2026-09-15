from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint, Date, DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from platform_app.adapters.database import Base
from platform_app.contracts.base import new_id, utcnow


class Account(Base):
    __tablename__ = "investment_accounts"
    __table_args__ = (
        UniqueConstraint("owner_id", "creation_key"),
        CheckConstraint("kind IN ('REAL','SIMULATED')", name="kind"),
        CheckConstraint("currency = 'CNY'", name="currency"),
        CheckConstraint("version >= 1", name="version"),
        CheckConstraint("max_position_percent BETWEEN 1 AND 100", name="risk_limit"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    kind: Mapped[str] = mapped_column(String(16))
    currency: Mapped[str] = mapped_column(String(3))
    max_position_percent: Mapped[int] = mapped_column(Integer)
    version: Mapped[int] = mapped_column(Integer, default=1)
    creation_key: Mapped[str] = mapped_column(String(128))
    creation_hash: Mapped[str] = mapped_column(String(64))
    creation_result: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CashEntry(Base):
    __tablename__ = "cash_entries"
    __table_args__ = (
        UniqueConstraint("account_id", "kind", "source_key", name="uq_cash_entries_source"),
        UniqueConstraint("account_id", "account_version", name="uq_cash_entries_version"),
        CheckConstraint(
            "kind IN ('OPENING','DEPOSIT','WITHDRAWAL','EXECUTION','REVERSAL')", name="kind",
        ),
        CheckConstraint(
            "(kind = 'WITHDRAWAL' AND amount < 0) OR "
            "(kind IN ('OPENING','DEPOSIT') AND amount > 0) OR "
            "kind IN ('EXECUTION','REVERSAL')",
            name="signed_amount",
        ),
        CheckConstraint(
            "(kind = 'EXECUTION') = (execution_id IS NOT NULL)", name="execution_link",
        ),
        CheckConstraint(
            "(kind = 'REVERSAL') = (correction_id IS NOT NULL)", name="correction_link",
        ),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("investment_accounts.id"), index=True)
    source_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(16))
    amount: Mapped[Decimal] = mapped_column(Numeric(20, 2))
    source: Mapped[str] = mapped_column(String(300))
    effective_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    account_version: Mapped[int] = mapped_column(Integer)
    execution_id: Mapped[str | None] = mapped_column(
        ForeignKey("executions.id"), unique=True,
    )
    correction_id: Mapped[str | None] = mapped_column(
        ForeignKey("execution_corrections.id"), unique=True,
    )


class Execution(Base):
    __tablename__ = "executions"
    __table_args__ = (
        UniqueConstraint("account_id", "source_key", name="uq_executions_source"),
        UniqueConstraint("account_id", "command_key", name="uq_executions_command"),
        UniqueConstraint("account_id", "account_version", name="uq_executions_version"),
        CheckConstraint("side IN ('BUY','SELL')", name="side"),
        CheckConstraint("quantity_shares > 0 AND quantity_shares <= 1000000000", name="quantity"),
        CheckConstraint("price > 0 AND gross_amount > 0 AND total_fees >= 0", name="amounts"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("investment_accounts.id"), index=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), index=True)
    source_key: Mapped[str] = mapped_column(String(128))
    command_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    fact_hash: Mapped[str] = mapped_column(String(64))
    side: Mapped[str] = mapped_column(String(4))
    quantity_shares: Mapped[int] = mapped_column(Integer)
    price: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    gross_amount: Mapped[Decimal] = mapped_column(Numeric(20, 2))
    total_fees: Mapped[Decimal] = mapped_column(Numeric(20, 2))
    fees: Mapped[dict] = mapped_column(JSONB)
    cash_delta: Mapped[Decimal] = mapped_column(Numeric(20, 2))
    realized_pnl: Mapped[Decimal | None] = mapped_column(Numeric(20, 2))
    executed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    source: Mapped[str] = mapped_column(String(300))
    account_version: Mapped[int] = mapped_column(Integer)
    plan_id: Mapped[str | None] = mapped_column(ForeignKey("execution_plans.id"), index=True)


class PositionLot(Base):
    __tablename__ = "position_lots"
    __table_args__ = (
        CheckConstraint("remaining_quantity >= 0", name="quantity"),
        CheckConstraint("remaining_basis >= 0", name="basis"),
        CheckConstraint("remaining_quantity > 0 OR remaining_basis = 0", name="closed_basis"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    execution_id: Mapped[str | None] = mapped_column(ForeignKey("executions.id"), unique=True)
    account_id: Mapped[str] = mapped_column(ForeignKey("investment_accounts.id"), index=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), index=True)
    acquired_date: Mapped[date] = mapped_column(Date)
    remaining_quantity: Mapped[int] = mapped_column(Integer)
    remaining_basis: Mapped[Decimal] = mapped_column(Numeric(20, 2))
    sequence: Mapped[int] = mapped_column(Integer)


class ExecutionCommand(Base):
    __tablename__ = "execution_commands"
    account_id: Mapped[str] = mapped_column(
        ForeignKey("investment_accounts.id"), primary_key=True,
    )
    command_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    execution_id: Mapped[str] = mapped_column(ForeignKey("executions.id"))
    result: Mapped[dict] = mapped_column(JSONB, default=dict)


class ExecutionCorrection(Base):
    __tablename__ = "execution_corrections"
    __table_args__ = (
        UniqueConstraint("account_id", "command_key", name="uq_corrections_command"),
        UniqueConstraint("account_id", "account_version", name="uq_corrections_version"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("investment_accounts.id"), index=True)
    execution_id: Mapped[str] = mapped_column(ForeignKey("executions.id"), unique=True)
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    reason: Mapped[str] = mapped_column(String(500))
    command_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    account_version: Mapped[int] = mapped_column(Integer)
    reversal_amount: Mapped[Decimal] = mapped_column(Numeric(20, 2))


class LotConsumption(Base):
    __tablename__ = "lot_consumptions"
    __table_args__ = (
        CheckConstraint("quantity > 0 AND basis >= 0", name="amounts"),
    )
    sell_execution_id: Mapped[str] = mapped_column(ForeignKey("executions.id"), primary_key=True)
    lot_id: Mapped[str] = mapped_column(ForeignKey("position_lots.id"), primary_key=True)
    quantity: Mapped[int] = mapped_column(Integer)
    basis: Mapped[Decimal] = mapped_column(Numeric(20, 2))


class ExecutionImport(Base):
    __tablename__ = "execution_imports"
    __table_args__ = (
        UniqueConstraint("account_id", "command_key", name="uq_execution_imports_command"),
        CheckConstraint("status IN ('READY','REJECTED','COMMITTED')", name="status"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("investment_accounts.id"), index=True)
    account_version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16))
    command_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    file_hash: Mapped[str] = mapped_column(String(64))
    facts: Mapped[list] = mapped_column(JSONB)
    rows: Mapped[list] = mapped_column(JSONB)
    creation_result: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    committed_version: Mapped[int | None] = mapped_column(Integer)


class ExecutionPlan(Base):
    __tablename__ = "execution_plans"
    __table_args__ = (
        CheckConstraint(
            "status IN ('CONFIRMED','PARTIALLY_RECORDED','COMPLETED',"
            "'CANCELLED','EXPIRED','INVALIDATED')", name="status"),
        CheckConstraint("side IN ('BUY','SELL')", name="side"),
        CheckConstraint("quantity_shares > 0 AND recorded_shares >= 0", name="quantity"),
        CheckConstraint("reserved_cash >= 0 AND reserved_shares >= 0", name="reservation"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("investment_accounts.id"), index=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"))
    side: Mapped[str] = mapped_column(String(4))
    quantity_shares: Mapped[int] = mapped_column(Integer)
    limit_price: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    fee_budget: Mapped[Decimal] = mapped_column(Numeric(20, 2))
    recorded_shares: Mapped[int] = mapped_column(Integer, default=0)
    reserved_cash: Mapped[Decimal] = mapped_column(Numeric(20, 2), default=Decimal(0))
    reserved_shares: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(24))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    reason: Mapped[str] = mapped_column(String(300))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PlanEvent(Base):
    __tablename__ = "plan_events"
    __table_args__ = (
        UniqueConstraint("account_id", "command_key", name="uq_plan_events_command"),
        UniqueConstraint("plan_id", "revision", name="uq_plan_events_revision"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("investment_accounts.id"), index=True)
    plan_id: Mapped[str] = mapped_column(ForeignKey("execution_plans.id"), index=True)
    account_version: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(24))
    command_key: Mapped[str] = mapped_column(String(256))
    reason: Mapped[str] = mapped_column(String(300))
    request_hash: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict] = mapped_column(JSONB)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
