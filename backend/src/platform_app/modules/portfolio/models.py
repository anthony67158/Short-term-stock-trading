from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint, DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint,
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
        UniqueConstraint("account_id", "source_key", name="uq_cash_entries_source"),
        UniqueConstraint("account_id", "account_version", name="uq_cash_entries_version"),
        CheckConstraint("kind IN ('OPENING','DEPOSIT','WITHDRAWAL')", name="kind"),
        CheckConstraint(
            "(kind = 'WITHDRAWAL' AND amount < 0) OR "
            "(kind IN ('OPENING','DEPOSIT') AND amount > 0)", name="signed_amount",
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
