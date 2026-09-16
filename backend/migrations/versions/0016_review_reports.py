"""Persist review reports and bounded improvement proposals.

Revision ID: 0016_review_reports
Revises: 0015_outcome_attribution
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0016_review_reports"
down_revision = "0015_outcome_attribution"


def upgrade():
    op.create_table(
        "review_reports",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("job_id", sa.String(32), nullable=False),
        sa.Column("review_date", sa.Date(), nullable=False),
        sa.Column("protocol_version", sa.String(80), nullable=False),
        sa.Column("model_id", sa.String(120), nullable=False),
        sa.Column("input_hash", sa.String(64), nullable=False),
        sa.Column("metric_snapshot", JSONB, nullable=False),
        sa.Column("output", JSONB, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"]),
        sa.UniqueConstraint(
            "owner_id",
            "review_date",
            name="uq_review_report_date",
        ),
        sa.UniqueConstraint("job_id", name="uq_review_report_job"),
    )
    op.create_index(
        "ix_review_reports_owner_id",
        "review_reports",
        ["owner_id"],
    )
    op.create_index(
        "ix_review_reports_review_date",
        "review_reports",
        ["review_date"],
    )
    op.create_table(
        "improvement_proposals",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("review_report_id", sa.String(32), nullable=False),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("hypothesis", sa.String(1200), nullable=False),
        sa.Column("change_type", sa.String(40), nullable=False),
        sa.Column("direction", sa.String(16), nullable=False),
        sa.Column("source_sample_ids", JSONB, nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column(
            "compiled_strategy_version_id",
            sa.String(32),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["review_report_id"],
            ["review_reports.id"],
        ),
        sa.ForeignKeyConstraint(
            ["compiled_strategy_version_id"],
            ["strategy_versions.id"],
        ),
        sa.CheckConstraint(
            "change_type IN ('DECISION_THRESHOLD','AGENT_PROTOCOL',"
            "'RISK_PARAMETER','FEATURE_SET','EXECUTION_POLICY')",
            name="ck_improvement_proposals_change_type",
        ),
        sa.CheckConstraint(
            "direction IN ('INCREASE','DECREASE','ADD','REMOVE','REVIEW')",
            name="ck_improvement_proposals_direction",
        ),
        sa.CheckConstraint(
            "status IN ('DRAFT','COMPILED','REJECTED')",
            name="ck_improvement_proposals_status",
        ),
        sa.CheckConstraint(
            "(status = 'COMPILED') = "
            "(compiled_strategy_version_id IS NOT NULL)",
            name="ck_improvement_proposals_compilation",
        ),
    )
    op.create_index(
        "ix_improvement_proposals_owner_id",
        "improvement_proposals",
        ["owner_id"],
    )
    op.create_index(
        "ix_improvement_proposals_review_report_id",
        "improvement_proposals",
        ["review_report_id"],
    )
    op.create_index(
        "ix_improvement_proposals_status",
        "improvement_proposals",
        ["status"],
    )


def downgrade():
    op.drop_table("improvement_proposals")
    op.drop_table("review_reports")
