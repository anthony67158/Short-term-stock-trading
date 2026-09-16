"""Persist server-side decision monitors and deduplicated notifications."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0012_monitoring_notifications"
down_revision = "0011_decision_plan_link"


def upgrade():
    op.create_table(
        "decision_monitors",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("account_id", sa.String(32), nullable=False),
        sa.Column("instrument_id", sa.String(9), nullable=False),
        sa.Column("decision_id", sa.String(160), nullable=False),
        sa.Column(
            "enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column(
            "status",
            sa.String(16),
            nullable=False,
            server_default="PAUSED",
        ),
        sa.Column(
            "next_review_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column("last_trigger_key", sa.String(64), nullable=True),
        sa.Column("last_job_id", sa.String(32), nullable=True),
        sa.Column(
            "last_triggered_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["investment_accounts.id"],
        ),
        sa.ForeignKeyConstraint(["instrument_id"], ["instruments.id"]),
        sa.ForeignKeyConstraint(["decision_id"], ["decisions.id"]),
        sa.ForeignKeyConstraint(["last_job_id"], ["jobs.id"]),
        sa.UniqueConstraint(
            "account_id",
            "instrument_id",
            name="uq_decision_monitor_position",
        ),
        sa.CheckConstraint(
            "status IN ('PAUSED','ACTIVE','TRIGGERED','FAILED')",
            name="ck_decision_monitors_status",
        ),
    )
    for column in (
        "owner_id",
        "account_id",
        "instrument_id",
        "decision_id",
        "next_review_at",
        "last_job_id",
    ):
        op.create_index(
            f"ix_decision_monitors_{column}",
            "decision_monitors",
            [column],
        )
    op.create_table(
        "notifications",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("source_outbox_id", sa.String(32), nullable=False),
        sa.Column("event_type", sa.String(60), nullable=False),
        sa.Column("aggregate_id", sa.String(160), nullable=False),
        sa.Column("severity", sa.String(16), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("message", sa.String(500), nullable=False),
        sa.Column("payload", JSONB, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "read_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["source_outbox_id"], ["outbox.id"]),
        sa.UniqueConstraint(
            "source_outbox_id",
            name="uq_notifications_source_outbox",
        ),
        sa.CheckConstraint(
            "severity IN ('INFO','ACTION','WARNING')",
            name="ck_notifications_severity",
        ),
    )
    for column in ("owner_id", "event_type", "created_at"):
        op.create_index(
            f"ix_notifications_{column}",
            "notifications",
            [column],
        )


def downgrade():
    op.drop_table("notifications")
    op.drop_table("decision_monitors")
