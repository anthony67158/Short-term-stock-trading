"""Durable jobs and transactional outbox."""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0001"
down_revision = None


def upgrade():
    op.create_table(
        "jobs",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("business_key", sa.String(128), nullable=False),
        sa.Column("input_hash", sa.String(64), nullable=False),
        sa.Column("payload", JSONB, nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("stage", sa.String(100), nullable=False),
        sa.Column("priority", sa.Integer, nullable=False),
        sa.Column("attempt", sa.Integer, nullable=False),
        sa.Column("fencing_token", sa.Integer, nullable=False),
        sa.Column("cancellation_requested", sa.Boolean, nullable=False),
        sa.Column("external_started", sa.Boolean, nullable=False),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("result", JSONB),
        sa.Column("error_code", sa.String(80)),
        sa.UniqueConstraint("owner_id", "kind", "business_key", name="uq_jobs_owner_id"),
        sa.CheckConstraint(
            "status IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED','EXPIRED')",
            name="ck_jobs_status",
        ),
    )
    op.create_index("ix_jobs_owner_id", "jobs", ["owner_id"])
    op.create_index("ix_jobs_status", "jobs", ["status"])
    op.create_table(
        "outbox",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("owner_id", sa.String(32), nullable=False),
        sa.Column("event_type", sa.String(60), nullable=False),
        sa.Column("aggregate_id", sa.String(32), nullable=False),
        sa.Column("payload", JSONB, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_outbox_owner_id", "outbox", ["owner_id"])


def downgrade():
    op.drop_table("outbox")
    op.drop_table("jobs")
