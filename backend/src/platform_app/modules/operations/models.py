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


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        UniqueConstraint("owner_id", "kind", "business_key"),
        CheckConstraint(
            "status IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED','EXPIRED')",
            name="status",
        ),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(String(32), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    business_key: Mapped[str] = mapped_column(String(128))
    input_hash: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), default="QUEUED", index=True)
    stage: Mapped[str] = mapped_column(String(100), default="等待处理")
    priority: Mapped[int] = mapped_column(Integer, default=0)
    attempt: Mapped[int] = mapped_column(Integer, default=0)
    fencing_token: Mapped[int] = mapped_column(Integer, default=0)
    cancellation_requested: Mapped[bool] = mapped_column(default=False)
    external_started: Mapped[bool] = mapped_column(default=False)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    result: Mapped[dict | None] = mapped_column(JSONB)
    error_code: Mapped[str | None] = mapped_column(String(80))


class Outbox(Base):
    __tablename__ = "outbox"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(String(32), index=True)
    event_type: Mapped[str] = mapped_column(String(60))
    aggregate_id: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        UniqueConstraint(
            "source_outbox_id",
            name="uq_notifications_source_outbox",
        ),
        CheckConstraint(
            "severity IN ('INFO','ACTION','WARNING')",
            name="severity",
        ),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(
        ForeignKey("users.id"),
        index=True,
    )
    source_outbox_id: Mapped[str] = mapped_column(
        ForeignKey("outbox.id"),
    )
    event_type: Mapped[str] = mapped_column(String(60), index=True)
    aggregate_id: Mapped[str] = mapped_column(String(160))
    severity: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(120))
    message: Mapped[str] = mapped_column(String(500))
    payload: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        index=True,
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
