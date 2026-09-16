"""Persist owner-scoped market search views.

Revision ID: 0018_market_saved_views
Revises: 0017_cycle_drift
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0018_market_saved_views"
down_revision = "0017_cycle_drift"


def upgrade():
    op.create_table(
        "market_saved_views",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("filters", JSONB, nullable=False),
        sa.Column("command_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.UniqueConstraint(
            "owner_id",
            "name",
            name="uq_market_saved_view_name",
        ),
        sa.UniqueConstraint(
            "owner_id",
            "command_key",
            name="uq_market_saved_view_command",
        ),
    )
    op.create_index(
        "ix_market_saved_views_owner_id",
        "market_saved_views",
        ["owner_id"],
    )


def downgrade():
    op.drop_table("market_saved_views")
