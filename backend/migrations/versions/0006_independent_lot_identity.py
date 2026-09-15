"""Separate lot identity from its acquisition execution without changing balances."""
from alembic import op
import sqlalchemy as sa

revision = "0006_lot_identity"
down_revision = "663f3b4aacad"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint("fk_lot_consumptions_buy_execution_id_executions",
                       "lot_consumptions", type_="foreignkey")
    op.drop_constraint("fk_position_lots_execution_id_executions",
                       "position_lots", type_="foreignkey")
    op.alter_column("position_lots", "execution_id", new_column_name="id")
    op.add_column("position_lots", sa.Column("execution_id", sa.String(32), nullable=True))
    op.execute("UPDATE position_lots SET execution_id = id")
    op.create_foreign_key("fk_position_lots_execution_id_executions", "position_lots",
                          "executions", ["execution_id"], ["id"])
    op.create_unique_constraint("uq_position_lots_execution_id", "position_lots", ["execution_id"])
    op.alter_column("lot_consumptions", "buy_execution_id", new_column_name="lot_id")
    op.create_foreign_key("fk_lot_consumptions_lot_id_position_lots", "lot_consumptions",
                          "position_lots", ["lot_id"], ["id"])


def downgrade():
    if op.get_bind().scalar(sa.text(
        "SELECT count(*) FROM position_lots WHERE execution_id IS NULL OR id <> execution_id"
    )):
        raise RuntimeError("存在非成交来源批次，不能降级为仅成交批次")
    op.drop_constraint("fk_lot_consumptions_lot_id_position_lots",
                       "lot_consumptions", type_="foreignkey")
    op.alter_column("lot_consumptions", "lot_id", new_column_name="buy_execution_id")
    op.drop_constraint("uq_position_lots_execution_id", "position_lots", type_="unique")
    op.drop_constraint("fk_position_lots_execution_id_executions",
                       "position_lots", type_="foreignkey")
    op.drop_column("position_lots", "execution_id")
    op.alter_column("position_lots", "id", new_column_name="execution_id")
    op.create_foreign_key("fk_position_lots_execution_id_executions", "position_lots",
                          "executions", ["execution_id"], ["id"])
    op.create_foreign_key("fk_lot_consumptions_buy_execution_id_executions", "lot_consumptions",
                          "executions", ["buy_execution_id"], ["id"])
