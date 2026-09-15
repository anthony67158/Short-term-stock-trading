"""Preserve replacement facts on immutable correction events."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0008_execution_replacement"
down_revision = "0007_lot_constraint_name"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("execution_corrections", sa.Column(
        "replacement", postgresql.JSONB(), nullable=True))


def downgrade():
    connection = op.get_bind()
    if connection.scalar(sa.text(
        "SELECT count(*) FROM execution_corrections WHERE replacement IS NOT NULL"
    )):
        raise RuntimeError("Cannot discard recorded replacement facts")
    op.drop_column("execution_corrections", "replacement")
