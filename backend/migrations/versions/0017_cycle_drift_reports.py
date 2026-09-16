"""Persist comparable cycle and protocol drift reports.

Revision ID: 0017_cycle_drift
Revises: 0016_review_reports
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0017_cycle_drift"
down_revision = "0016_review_reports"


def upgrade():
    op.create_table(
        "cycle_drift_reports",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("baseline_date", sa.Date(), nullable=True),
        sa.Column("current_date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("comparison_key", sa.String(64), nullable=False),
        sa.Column("metrics", JSONB, nullable=False),
        sa.Column("blocker_codes", JSONB, nullable=False),
        sa.Column("cycle_support", JSONB, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.UniqueConstraint(
            "owner_id",
            "current_date",
            name="uq_cycle_drift_report_date",
        ),
        sa.CheckConstraint(
            "status IN ('STABLE','WARNING','UNSUPPORTED')",
            name="ck_cycle_drift_reports_status",
        ),
    )
    op.create_index(
        "ix_cycle_drift_reports_owner_id",
        "cycle_drift_reports",
        ["owner_id"],
    )
    op.create_index(
        "ix_cycle_drift_reports_current_date",
        "cycle_drift_reports",
        ["current_date"],
    )
    op.create_index(
        "ix_cycle_drift_reports_status",
        "cycle_drift_reports",
        ["status"],
    )


def downgrade():
    op.drop_table("cycle_drift_reports")
