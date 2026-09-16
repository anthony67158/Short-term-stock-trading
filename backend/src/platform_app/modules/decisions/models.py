from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from platform_app.adapters.database import Base
from platform_app.contracts.base import new_id, utcnow


class DecisionContextRecord(Base):
    __tablename__ = "decision_contexts"
    __table_args__ = (
        UniqueConstraint(
            "owner_id",
            "context_hash",
            name="uq_decision_context_owner_hash",
        ),
        CheckConstraint("account_version >= 1", name="account_version"),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    account_id: Mapped[str] = mapped_column(
        ForeignKey("investment_accounts.id"),
        index=True,
    )
    instrument_id: Mapped[str] = mapped_column(
        ForeignKey("instruments.id"),
        index=True,
    )
    account_version: Mapped[int] = mapped_column(Integer)
    release_id: Mapped[str] = mapped_column(String(160))
    context_hash: Mapped[str] = mapped_column(String(64))
    snapshot: Mapped[dict] = mapped_column(JSONB)
    assessment_ids: Mapped[list] = mapped_column(JSONB)
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
    )


class DecisionRecord(Base):
    __tablename__ = "decisions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('READY','CONDITIONAL','UNAVAILABLE','EXPIRED','SUPERSEDED')",
            name="status",
        ),
        CheckConstraint(
            "action IN ('BUY','ADD','HOLD','REDUCE','EXIT','WAIT','NONE')",
            name="action",
        ),
        CheckConstraint("account_version >= 1", name="account_version"),
    )
    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    account_id: Mapped[str] = mapped_column(
        ForeignKey("investment_accounts.id"),
        index=True,
    )
    instrument_id: Mapped[str] = mapped_column(
        ForeignKey("instruments.id"),
        index=True,
    )
    context_id: Mapped[str] = mapped_column(
        ForeignKey("decision_contexts.id"),
        unique=True,
    )
    schema_version: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(20), index=True)
    action: Mapped[str] = mapped_column(String(16))
    account_version: Mapped[int] = mapped_column(Integer)
    release_id: Mapped[str] = mapped_column(String(160))
    payload: Mapped[dict] = mapped_column(JSONB)
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    valid_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
    )


class CurrentDecision(Base):
    __tablename__ = "current_decisions"
    account_id: Mapped[str] = mapped_column(
        ForeignKey("investment_accounts.id"),
        primary_key=True,
    )
    instrument_id: Mapped[str] = mapped_column(
        ForeignKey("instruments.id"),
        primary_key=True,
    )
    decision_id: Mapped[str] = mapped_column(
        ForeignKey("decisions.id"),
        unique=True,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
    )
