from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from platform_app.adapters.database import Base
from platform_app.contracts.base import new_id, utcnow


class ProspectiveSample(Base):
    __tablename__ = "prospective_samples"
    __table_args__ = (
        UniqueConstraint(
            "owner_id",
            "source_key",
            name="uq_prospective_sample_source",
        ),
        UniqueConstraint(
            "owner_id",
            "decision_context_hash",
            name="uq_prospective_sample_context",
        ),
        CheckConstraint(
            "status IN ('PENDING','MATURED','EXCLUDED')",
            name="status",
        ),
        CheckConstraint(
            "(status = 'PENDING' AND matured_at IS NULL AND exclusion_reason IS NULL) OR "
            "(status = 'MATURED' AND matured_at IS NOT NULL AND exclusion_reason IS NULL) OR "
            "(status = 'EXCLUDED' AND matured_at IS NOT NULL AND exclusion_reason IS NOT NULL)",
            name="terminal_fields",
        ),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    account_id: Mapped[str | None] = mapped_column(
        ForeignKey("investment_accounts.id"),
        index=True,
    )
    instrument_id: Mapped[str] = mapped_column(
        ForeignKey("instruments.id"),
        index=True,
    )
    assessment_id: Mapped[str] = mapped_column(
        ForeignKey("research_assessments.id"),
        index=True,
    )
    source_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    decision_context_hash: Mapped[str] = mapped_column(String(64))
    schema_version: Mapped[str] = mapped_column(String(80))
    decision_as_of: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        index=True,
    )
    horizon_end_date: Mapped[date] = mapped_column(Date, index=True)
    market_snapshot_ref: Mapped[str] = mapped_column(String(160))
    ranking_bundle_id: Mapped[str] = mapped_column(String(120))
    quant_bundle_id: Mapped[str] = mapped_column(String(120))
    agent_protocol_version: Mapped[str] = mapped_column(String(80))
    agent_feature_schema_version: Mapped[str] = mapped_column(String(80))
    agent_features: Mapped[dict] = mapped_column(JSONB)
    quant_prediction: Mapped[dict] = mapped_column(JSONB)
    scenario: Mapped[dict] = mapped_column(JSONB)
    context: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
    )
    matured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    exclusion_reason: Mapped[str | None] = mapped_column(String(160))


class ProspectiveOutcome(Base):
    __tablename__ = "prospective_outcomes"
    sample_id: Mapped[str] = mapped_column(
        ForeignKey("prospective_samples.id"),
        primary_key=True,
    )
    simulation_policy_version: Mapped[str] = mapped_column(String(120))
    source_dataset_id: Mapped[str] = mapped_column(String(120))
    source_dataset_sha256: Mapped[str] = mapped_column(String(64))
    simulation_outcome: Mapped[dict] = mapped_column(JSONB)
    actual_execution_id: Mapped[str | None] = mapped_column(
        ForeignKey("executions.id"),
        unique=True,
    )
    actual_execution_outcome: Mapped[dict] = mapped_column(JSONB)
    attribution: Mapped[dict] = mapped_column(JSONB)
    matured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
