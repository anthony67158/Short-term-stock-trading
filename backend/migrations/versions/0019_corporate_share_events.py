"""Record settled stock dividends and split shares.

Revision ID: 0019_corporate_shares
Revises: 0018_market_saved_views
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0019_corporate_shares"
down_revision = "0018_market_saved_views"


def upgrade():
    op.create_table(
        "corporate_share_events",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("account_id", sa.String(32), nullable=False),
        sa.Column("instrument_id", sa.String(9), nullable=False),
        sa.Column("kind", sa.String(24), nullable=False),
        sa.Column("quantity_shares", sa.Integer(), nullable=False),
        sa.Column(
            "effective_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column("source_key", sa.String(128), nullable=False),
        sa.Column("source", sa.String(300), nullable=False),
        sa.Column("command_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("account_version", sa.Integer(), nullable=False),
        sa.Column("allocations", JSONB, nullable=False),
        sa.Column(
            "recorded_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["investment_accounts.id"],
        ),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"]),
        sa.UniqueConstraint(
            "account_id",
            "source_key",
            name="uq_corporate_share_event_source",
        ),
        sa.UniqueConstraint(
            "account_id",
            "command_key",
            name="uq_corporate_share_event_command",
        ),
        sa.UniqueConstraint(
            "account_id",
            "account_version",
            name="uq_corporate_share_event_version",
        ),
        sa.CheckConstraint(
            "quantity_shares > 0 AND quantity_shares <= 1000000000",
            name="ck_corporate_share_events_quantity",
        ),
        sa.CheckConstraint(
            "kind IN ('STOCK_DIVIDEND','SPLIT')",
            name="ck_corporate_share_events_kind",
        ),
    )
    op.create_index(
        "ix_corporate_share_events_account_id",
        "corporate_share_events",
        ["account_id"],
    )
    op.create_index(
        "ix_corporate_share_events_instrument_id",
        "corporate_share_events",
        ["instrument_id"],
    )


def downgrade():
    op.drop_table("corporate_share_events")
