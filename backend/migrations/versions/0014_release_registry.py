"""Audit candidate approval, activation and rollback."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0014_release_registry"
down_revision = "0013_experiment_registry"


def upgrade():
    op.create_table(
        "release_records",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("bundle_id", sa.String(160), nullable=False),
        sa.Column("operation", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("deployment_mode", sa.String(16), nullable=False),
        sa.Column("manifest_path", sa.Text(), nullable=False),
        sa.Column("manifest_sha256", sa.String(64), nullable=False),
        sa.Column(
            "source_candidate_bundle_id",
            sa.String(160),
            nullable=True,
        ),
        sa.Column("previous_bundle_id", sa.String(160), nullable=True),
        sa.Column(
            "rollback_target_bundle_id",
            sa.String(160),
            nullable=True,
        ),
        sa.Column("strategy_version_id", sa.String(32), nullable=False),
        sa.Column("experiment_id", sa.String(32), nullable=False),
        sa.Column("reason", sa.String(500), nullable=False),
        sa.Column("blocker_codes", JSONB, nullable=False),
        sa.Column(
            "allows_new_risk",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("request_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "activated_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["strategy_version_id"],
            ["strategy_versions.id"],
        ),
        sa.ForeignKeyConstraint(["experiment_id"], ["experiments.id"]),
        sa.UniqueConstraint(
            "owner_id",
            "request_key",
            name="uq_release_record_request",
        ),
        sa.CheckConstraint(
            "operation IN ('CANDIDATE','ACTIVATE','ROLLBACK')",
            name="ck_release_records_operation",
        ),
        sa.CheckConstraint(
            "status IN ('APPROVED','REJECTED','ACTIVE','RETIRED')",
            name="ck_release_records_status",
        ),
        sa.CheckConstraint(
            "deployment_mode = 'SHADOW'",
            name="ck_release_records_deployment_mode",
        ),
        sa.CheckConstraint(
            "allows_new_risk = false",
            name="ck_release_records_shadow_risk",
        ),
        sa.CheckConstraint(
            "(operation = 'CANDIDATE' AND status IN ('APPROVED','REJECTED') "
            "AND activated_at IS NULL) OR "
            "(operation IN ('ACTIVATE','ROLLBACK') "
            "AND status IN ('ACTIVE','RETIRED') AND activated_at IS NOT NULL)",
            name="ck_release_records_lifecycle",
        ),
    )
    for column in (
        "owner_id",
        "bundle_id",
        "status",
        "strategy_version_id",
        "experiment_id",
    ):
        op.create_index(
            f"ix_release_records_{column}",
            "release_records",
            [column],
        )
    op.create_index(
        "uq_release_active_mode",
        "release_records",
        ["deployment_mode"],
        unique=True,
        postgresql_where=sa.text("status = 'ACTIVE'"),
    )


def downgrade():
    op.drop_table("release_records")
