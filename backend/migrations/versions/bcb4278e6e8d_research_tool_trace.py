"""research tool trace

Revision ID: bcb4278e6e8d
Revises: 08e085a79bba
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "bcb4278e6e8d"
down_revision = "08e085a79bba"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "research_assessments",
        sa.Column(
            "tool_trace",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.alter_column("research_assessments", "tool_trace", server_default=None)


def downgrade() -> None:
    if op.get_bind().scalar(
        sa.text(
            "SELECT count(*) FROM research_assessments "
            "WHERE tool_trace != '[]'::jsonb"
        )
    ):
        raise RuntimeError("存在Agent工具审计，禁止降级丢失")
    op.drop_column("research_assessments", "tool_trace")
