"""Separate actual execution outcomes from simulated counterfactuals.

Revision ID: 0015_outcome_attribution
Revises: 0014_release_registry
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0015_outcome_attribution"
down_revision = "0014_release_registry"


def upgrade():
    op.add_column(
        "prospective_outcomes",
        sa.Column(
            "actual_execution_outcome",
            JSONB,
            nullable=False,
            server_default=sa.text(
                """'{"schemaVersion":"actual-execution-outcome.v1","status":"NOT_ASSESSED"}'::jsonb"""
            ),
        ),
    )
    op.add_column(
        "prospective_outcomes",
        sa.Column(
            "attribution",
            JSONB,
            nullable=False,
            server_default=sa.text(
                """'{"schemaVersion":"outcome-attribution.v1"}'::jsonb"""
            ),
        ),
    )
    op.alter_column(
        "prospective_outcomes",
        "actual_execution_outcome",
        server_default=None,
    )
    op.alter_column(
        "prospective_outcomes",
        "attribution",
        server_default=None,
    )


def downgrade():
    op.drop_column("prospective_outcomes", "attribution")
    op.drop_column(
        "prospective_outcomes",
        "actual_execution_outcome",
    )
