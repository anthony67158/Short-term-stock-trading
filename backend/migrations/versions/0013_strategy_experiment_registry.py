"""Freeze strategy versions and preserve four-way experiment results."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0013_experiment_registry"
down_revision = "0012_monitoring_notifications"


def upgrade():
    op.create_table(
        "strategy_versions",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("strategy_key", sa.String(80), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("hypothesis", sa.String(1000), nullable=False),
        sa.Column("scope", JSONB, nullable=False),
        sa.Column("config", JSONB, nullable=False),
        sa.Column("dataset", JSONB, nullable=False),
        sa.Column("split", JSONB, nullable=False),
        sa.Column("release_policy", JSONB, nullable=False),
        sa.Column("fee_policy_version", sa.String(120), nullable=False),
        sa.Column("risk_policy_version", sa.String(120), nullable=False),
        sa.Column(
            "simulation_policy_version",
            sa.String(120),
            nullable=False,
        ),
        sa.Column("confirmation_set_id", sa.String(160), nullable=False),
        sa.Column(
            "minimum_effective_samples",
            sa.Integer(),
            nullable=False,
        ),
        sa.Column("config_hash", sa.String(64), nullable=False),
        sa.Column("request_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "frozen_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "evaluated_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.UniqueConstraint(
            "owner_id",
            "strategy_key",
            "version",
            name="uq_strategy_version_number",
        ),
        sa.UniqueConstraint(
            "owner_id",
            "strategy_key",
            "config_hash",
            name="uq_strategy_version_config",
        ),
        sa.UniqueConstraint(
            "owner_id",
            "request_key",
            name="uq_strategy_version_request",
        ),
        sa.CheckConstraint(
            "status IN ('DRAFT','FROZEN','EVALUATED')",
            name="ck_strategy_versions_status",
        ),
        sa.CheckConstraint(
            "version >= 1",
            name="ck_strategy_versions_version",
        ),
        sa.CheckConstraint(
            "revision >= 1",
            name="ck_strategy_versions_revision",
        ),
        sa.CheckConstraint(
            "minimum_effective_samples >= 1",
            name="ck_strategy_versions_minimum_effective_samples",
        ),
        sa.CheckConstraint(
            "(status = 'DRAFT' AND frozen_at IS NULL AND evaluated_at IS NULL) OR "
            "(status = 'FROZEN' AND frozen_at IS NOT NULL AND evaluated_at IS NULL) OR "
            "(status = 'EVALUATED' AND frozen_at IS NOT NULL AND evaluated_at IS NOT NULL)",
            name="ck_strategy_versions_lifecycle",
        ),
    )
    for column in ("owner_id", "strategy_key", "status"):
        op.create_index(
            f"ix_strategy_versions_{column}",
            "strategy_versions",
            [column],
        )
    op.create_table(
        "experiments",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("strategy_version_id", sa.String(32), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("config_hash", sa.String(64), nullable=False),
        sa.Column("request_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("confirmation_set_id", sa.String(160), nullable=False),
        sa.Column("sample_count", sa.Integer(), nullable=False),
        sa.Column("result", JSONB, nullable=False),
        sa.Column("failure_code", sa.String(120), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "finished_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["strategy_version_id"],
            ["strategy_versions.id"],
        ),
        sa.UniqueConstraint(
            "owner_id",
            "request_key",
            name="uq_experiment_request",
        ),
        sa.UniqueConstraint(
            "strategy_version_id",
            name="uq_experiment_strategy_version",
        ),
        sa.CheckConstraint(
            "kind = 'FOUR_WAY_ABLATION'",
            name="ck_experiments_kind",
        ),
        sa.CheckConstraint(
            "status IN ('SUCCEEDED','FAILED')",
            name="ck_experiments_status",
        ),
        sa.CheckConstraint(
            "sample_count >= 0",
            name="ck_experiments_sample_count",
        ),
        sa.CheckConstraint(
            "(status = 'SUCCEEDED' AND failure_code IS NULL) OR "
            "(status = 'FAILED' AND failure_code IS NOT NULL)",
            name="ck_experiments_terminal_fields",
        ),
    )
    for column in ("owner_id", "strategy_version_id", "status"):
        op.create_index(
            f"ix_experiments_{column}",
            "experiments",
            [column],
        )


def downgrade():
    op.drop_table("experiments")
    op.drop_table("strategy_versions")
