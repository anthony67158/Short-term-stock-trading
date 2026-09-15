from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from platform_app.adapters.database import Base
from platform_app.contracts.base import new_id, utcnow


class Evidence(Base):
    __tablename__ = "evidence_items"
    __table_args__ = (UniqueConstraint("owner_id", "source_key"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), index=True)
    source_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(200))
    source_url: Mapped[str] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text)
    quote: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64))
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    provenance: Mapped[str] = mapped_column(String(30), default="USER_SUPPLIED")
    validation: Mapped[str] = mapped_column(String(30), default="QUOTE_MATCHED")


class Assessment(Base):
    __tablename__ = "research_assessments"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    instrument_id: Mapped[str] = mapped_column(ForeignKey("instruments.id"), index=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"), unique=True)
    protocol_version: Mapped[str] = mapped_column(String(80))
    model_id: Mapped[str] = mapped_column(String(120))
    as_of: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    input_hash: Mapped[str] = mapped_column(String(64))
    evidence_ids: Mapped[list] = mapped_column(JSONB)
    output: Mapped[dict] = mapped_column(JSONB)
