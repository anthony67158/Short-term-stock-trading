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


class ReviewReport(Base):
    __tablename__ = "review_reports"
    __table_args__ = (
        UniqueConstraint(
            "owner_id",
            "review_date",
            name="uq_review_report_date",
        ),
        UniqueConstraint("job_id", name="uq_review_report_job"),
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
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id"))
    review_date: Mapped[date] = mapped_column(Date, index=True)
    protocol_version: Mapped[str] = mapped_column(String(80))
    model_id: Mapped[str] = mapped_column(String(120))
    input_hash: Mapped[str] = mapped_column(String(64))
    metric_snapshot: Mapped[dict] = mapped_column(JSONB)
    output: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
    )


class ImprovementProposal(Base):
    __tablename__ = "improvement_proposals"
    __table_args__ = (
        CheckConstraint(
            "change_type IN ('DECISION_THRESHOLD','AGENT_PROTOCOL',"
            "'RISK_PARAMETER','FEATURE_SET','EXECUTION_POLICY')",
            name="change_type",
        ),
        CheckConstraint(
            "direction IN ('INCREASE','DECREASE','ADD','REMOVE','REVIEW')",
            name="direction",
        ),
        CheckConstraint(
            "status IN ('DRAFT','COMPILED','REJECTED')",
            name="status",
        ),
        CheckConstraint(
            "(status = 'COMPILED') = "
            "(compiled_strategy_version_id IS NOT NULL)",
            name="compilation",
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
    review_report_id: Mapped[str] = mapped_column(
        ForeignKey("review_reports.id"),
        index=True,
    )
    title: Mapped[str] = mapped_column(String(160))
    hypothesis: Mapped[str] = mapped_column(String(1200))
    change_type: Mapped[str] = mapped_column(String(40))
    direction: Mapped[str] = mapped_column(String(16))
    source_sample_ids: Mapped[list] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), default="DRAFT", index=True)
    compiled_strategy_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("strategy_versions.id"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
    )
