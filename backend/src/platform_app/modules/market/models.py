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


class Instrument(Base):
    __tablename__ = "instruments"
    __table_args__ = (
        CheckConstraint("exchange IN ('SH','SZ','BJ')", name="exchange"),
        CheckConstraint("id = exchange || '.' || code", name="identity"),
    )
    id: Mapped[str] = mapped_column(String(9), primary_key=True)
    code: Mapped[str] = mapped_column(String(6), index=True)
    exchange: Mapped[str] = mapped_column(String(2))
    name: Mapped[str] = mapped_column(String(80), index=True)
    board: Mapped[str] = mapped_column(String(16))
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    is_current: Mapped[bool] = mapped_column(default=True)


class UniverseSnapshot(Base):
    __tablename__ = "universe_snapshots"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    source: Mapped[str] = mapped_column(String(80))
    source_url: Mapped[str] = mapped_column(String(300))
    count: Mapped[int] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(64))
    acquired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    members: Mapped[list] = mapped_column(JSONB)


class Watch(Base):
    __tablename__ = "watchlist_members"
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SavedView(Base):
    __tablename__ = "market_saved_views"
    __table_args__ = (
        UniqueConstraint(
            "owner_id",
            "name",
            name="uq_market_saved_view_name",
        ),
        UniqueConstraint(
            "owner_id",
            "command_key",
            name="uq_market_saved_view_command",
        ),
    )
    id: Mapped[str] = mapped_column(
        String(32),
        primary_key=True,
        default=new_id,
    )
    owner_id: Mapped[str] = mapped_column(
        ForeignKey("users.id"),
        index=True,
    )
    name: Mapped[str] = mapped_column(String(80))
    filters: Mapped[dict] = mapped_column(JSONB)
    command_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
    )
