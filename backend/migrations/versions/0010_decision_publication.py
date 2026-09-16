"""Immutable decision contexts, decisions and current pointers."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0010_decision_publication"
down_revision = "e4a9c6f87d10"


def upgrade():
    op.create_table(
        "decision_contexts",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("account_id", sa.String(32), nullable=False),
        sa.Column("instrument_id", sa.String(9), nullable=False),
        sa.Column("account_version", sa.Integer(), nullable=False),
        sa.Column("release_id", sa.String(160), nullable=False),
        sa.Column("context_hash", sa.String(64), nullable=False),
        sa.Column("snapshot", JSONB, nullable=False),
        sa.Column("assessment_ids", JSONB, nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["account_id"], ["investment_accounts.id"]),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"]),
        sa.UniqueConstraint(
            "owner_id",
            "context_hash",
            name="uq_decision_context_owner_hash",
        ),
        sa.CheckConstraint(
            "account_version >= 1",
            name="ck_decision_contexts_account_version",
        ),
    )
    for column in ("owner_id", "account_id", "instrument_id"):
        op.create_index(
            f"ix_decision_contexts_{column}",
            "decision_contexts",
            [column],
        )
    op.create_table(
        "decisions",
        sa.Column("id", sa.String(160), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("account_id", sa.String(32), nullable=False),
        sa.Column("instrument_id", sa.String(9), nullable=False),
        sa.Column("context_id", sa.String(32), nullable=False, unique=True),
        sa.Column("schema_version", sa.String(80), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("account_version", sa.Integer(), nullable=False),
        sa.Column("release_id", sa.String(160), nullable=False),
        sa.Column("payload", JSONB, nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("valid_until", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["account_id"], ["investment_accounts.id"]),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"]),
        sa.ForeignKeyConstraint(["context_id"], ["decision_contexts.id"]),
        sa.CheckConstraint(
            "status IN ('READY','CONDITIONAL','UNAVAILABLE','EXPIRED','SUPERSEDED')",
            name="ck_decisions_status",
        ),
        sa.CheckConstraint(
            "action IN ('BUY','ADD','HOLD','REDUCE','EXIT','WAIT','NONE')",
            name="ck_decisions_action",
        ),
        sa.CheckConstraint(
            "account_version >= 1",
            name="ck_decisions_account_version",
        ),
    )
    for column in ("owner_id", "account_id", "instrument_id", "status"):
        op.create_index(f"ix_decisions_{column}", "decisions", [column])
    op.create_table(
        "current_decisions",
        sa.Column("account_id", sa.String(32), primary_key=True),
        sa.Column("instrument_id", sa.String(9), primary_key=True),
        sa.Column("decision_id", sa.String(160), nullable=False, unique=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["investment_accounts.id"]),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"]),
        sa.ForeignKeyConstraint(["decision_id"], ["decisions.id"]),
    )


def downgrade():
    op.drop_table("current_decisions")
    op.drop_table("decisions")
    op.drop_table("decision_contexts")
