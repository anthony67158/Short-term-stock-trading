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


class StrategyVersion(Base):
    __tablename__ = "strategy_versions"
    __table_args__ = (
        UniqueConstraint(
            "owner_id",
            "strategy_key",
            "version",
            name="uq_strategy_version_number",
        ),
        UniqueConstraint(
            "owner_id",
            "strategy_key",
            "config_hash",
            name="uq_strategy_version_config",
        ),
        UniqueConstraint(
            "owner_id",
            "request_key",
            name="uq_strategy_version_request",
        ),
        CheckConstraint(
            "status IN ('DRAFT','FROZEN','EVALUATED')",
            name="status",
        ),
        CheckConstraint("version >= 1", name="version"),
        CheckConstraint("revision >= 1", name="revision"),
        CheckConstraint(
            "minimum_effective_samples >= 1",
            name="minimum_effective_samples",
        ),
        CheckConstraint(
            "(status = 'DRAFT' AND frozen_at IS NULL AND evaluated_at IS NULL) OR "
            "(status = 'FROZEN' AND frozen_at IS NOT NULL AND evaluated_at IS NULL) OR "
            "(status = 'EVALUATED' AND frozen_at IS NOT NULL AND evaluated_at IS NOT NULL)",
            name="lifecycle",
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
    strategy_key: Mapped[str] = mapped_column(String(80), index=True)
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(
        String(16),
        default="DRAFT",
        index=True,
    )
    name: Mapped[str] = mapped_column(String(120))
    hypothesis: Mapped[str] = mapped_column(String(1000))
    scope: Mapped[dict] = mapped_column(JSONB)
    config: Mapped[dict] = mapped_column(JSONB)
    dataset: Mapped[dict] = mapped_column(JSONB)
    split: Mapped[dict] = mapped_column(JSONB)
    release_policy: Mapped[dict] = mapped_column(JSONB)
    fee_policy_version: Mapped[str] = mapped_column(String(120))
    risk_policy_version: Mapped[str] = mapped_column(String(120))
    simulation_policy_version: Mapped[str] = mapped_column(String(120))
    confirmation_set_id: Mapped[str] = mapped_column(String(160))
    minimum_effective_samples: Mapped[int] = mapped_column(Integer)
    config_hash: Mapped[str] = mapped_column(String(64))
    request_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
    )
    frozen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
    )
    evaluated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
    )


class Experiment(Base):
    __tablename__ = "experiments"
    __table_args__ = (
        UniqueConstraint(
            "owner_id",
            "request_key",
            name="uq_experiment_request",
        ),
        UniqueConstraint(
            "strategy_version_id",
            name="uq_experiment_strategy_version",
        ),
        CheckConstraint(
            "kind = 'FOUR_WAY_ABLATION'",
            name="kind",
        ),
        CheckConstraint(
            "status IN ('SUCCEEDED','FAILED')",
            name="status",
        ),
        CheckConstraint("sample_count >= 0", name="sample_count"),
        CheckConstraint(
            "(status = 'SUCCEEDED' AND failure_code IS NULL) OR "
            "(status = 'FAILED' AND failure_code IS NOT NULL)",
            name="terminal_fields",
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
    strategy_version_id: Mapped[str] = mapped_column(
        ForeignKey("strategy_versions.id"),
        index=True,
    )
    kind: Mapped[str] = mapped_column(
        String(32),
        default="FOUR_WAY_ABLATION",
    )
    status: Mapped[str] = mapped_column(String(16), index=True)
    config_hash: Mapped[str] = mapped_column(String(64))
    request_key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    confirmation_set_id: Mapped[str] = mapped_column(String(160))
    sample_count: Mapped[int] = mapped_column(Integer)
    result: Mapped[dict] = mapped_column(JSONB)
    failure_code: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
    )
    finished_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
    )
