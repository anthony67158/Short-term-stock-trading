"""Prospective Agent samples and separately matured outcomes.

Revision ID: e4a9c6f87d10
Revises: bcb4278e6e8d
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "e4a9c6f87d10"
down_revision = "bcb4278e6e8d"


def upgrade():
    op.create_table(
        "prospective_samples",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("account_id", sa.String(32)),
        sa.Column("instrument_id", sa.String(9), nullable=False),
        sa.Column("assessment_id", sa.String(32), nullable=False),
        sa.Column("source_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("decision_context_hash", sa.String(64), nullable=False),
        sa.Column("schema_version", sa.String(80), nullable=False),
        sa.Column("decision_as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("horizon_end_date", sa.Date(), nullable=False),
        sa.Column("market_snapshot_ref", sa.String(160), nullable=False),
        sa.Column("ranking_bundle_id", sa.String(120), nullable=False),
        sa.Column("quant_bundle_id", sa.String(120), nullable=False),
        sa.Column("agent_protocol_version", sa.String(80), nullable=False),
        sa.Column("agent_feature_schema_version", sa.String(80), nullable=False),
        sa.Column("agent_features", JSONB, nullable=False),
        sa.Column("quant_prediction", JSONB, nullable=False),
        sa.Column("scenario", JSONB, nullable=False),
        sa.Column("context", JSONB, nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("matured_at", sa.DateTime(timezone=True)),
        sa.Column("exclusion_reason", sa.String(160)),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_prospective_samples_owner_id_users",
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["investment_accounts.id"],
            name="fk_prospective_samples_account_id_investment_accounts",
        ),
        sa.ForeignKeyConstraint(
            ["instrument_id"],
            ["instruments.id"],
            name="fk_prospective_samples_instrument_id_instruments",
        ),
        sa.ForeignKeyConstraint(
            ["assessment_id"],
            ["research_assessments.id"],
            name="fk_prospective_samples_assessment_id_research_assessments",
        ),
        sa.UniqueConstraint(
            "owner_id",
            "source_key",
            name="uq_prospective_sample_source",
        ),
        sa.UniqueConstraint(
            "owner_id",
            "decision_context_hash",
            name="uq_prospective_sample_context",
        ),
        sa.CheckConstraint(
            "status IN ('PENDING','MATURED','EXCLUDED')",
            name="ck_prospective_samples_status",
        ),
        sa.CheckConstraint(
            "(status = 'PENDING' AND matured_at IS NULL AND exclusion_reason IS NULL) OR "
            "(status = 'MATURED' AND matured_at IS NOT NULL AND exclusion_reason IS NULL) OR "
            "(status = 'EXCLUDED' AND matured_at IS NOT NULL AND exclusion_reason IS NOT NULL)",
            name="ck_prospective_samples_terminal_fields",
        ),
    )
    for column in (
        "owner_id",
        "account_id",
        "instrument_id",
        "assessment_id",
        "decision_as_of",
        "horizon_end_date",
        "status",
    ):
        op.create_index(
            f"ix_prospective_samples_{column}",
            "prospective_samples",
            [column],
        )
    op.create_table(
        "prospective_outcomes",
        sa.Column(
            "sample_id",
            sa.String(32),
            sa.ForeignKey(
                "prospective_samples.id",
                name="fk_prospective_outcomes_sample_id_prospective_samples",
            ),
            primary_key=True,
        ),
        sa.Column("simulation_policy_version", sa.String(120), nullable=False),
        sa.Column("source_dataset_id", sa.String(120), nullable=False),
        sa.Column("source_dataset_sha256", sa.String(64), nullable=False),
        sa.Column("simulation_outcome", JSONB, nullable=False),
        sa.Column(
            "actual_execution_id",
            sa.String(32),
            sa.ForeignKey(
                "executions.id",
                name="fk_prospective_outcomes_actual_execution_id_executions",
            ),
            unique=True,
        ),
        sa.Column("matured_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    op.drop_table("prospective_outcomes")
    op.drop_table("prospective_samples")
