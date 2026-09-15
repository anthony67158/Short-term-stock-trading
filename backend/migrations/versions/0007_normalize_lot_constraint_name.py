"""Normalize an existing enforced constraint name without rebuilding financial rows."""
from alembic import op

revision = "0007_lot_constraint_name"
down_revision = "0a722e336341"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE position_lots RENAME CONSTRAINT "
               "ck_position_lots_ck_position_lots_single_origin TO ck_position_lots_single_origin")


def downgrade():
    op.execute("ALTER TABLE position_lots RENAME CONSTRAINT "
               "ck_position_lots_single_origin TO ck_position_lots_ck_position_lots_single_origin")
