"""Link user-confirmed execution plans to current joint decisions."""

import sqlalchemy as sa
from alembic import op

revision = "0011_decision_plan_link"
down_revision = "0010_decision_publication"


def upgrade():
    op.add_column(
        "execution_plans",
        sa.Column(
            "source",
            sa.String(24),
            nullable=False,
            server_default="USER",
        ),
    )
    op.add_column(
        "execution_plans",
        sa.Column("decision_id", sa.String(160), nullable=True),
    )
    op.create_foreign_key(
        "fk_execution_plans_decision_id_decisions",
        "execution_plans",
        "decisions",
        ["decision_id"],
        ["id"],
    )
    op.create_unique_constraint(
        "uq_execution_plans_decision_id",
        "execution_plans",
        ["decision_id"],
    )
    op.create_check_constraint(
        "ck_execution_plans_source",
        "execution_plans",
        "source IN ('USER','SYSTEM_DECISION')",
    )
    op.create_check_constraint(
        "ck_execution_plans_source_link",
        "execution_plans",
        "(source = 'USER' AND decision_id IS NULL) OR "
        "(source = 'SYSTEM_DECISION' AND decision_id IS NOT NULL)",
    )


def downgrade():
    op.drop_constraint(
        "ck_execution_plans_source_link",
        "execution_plans",
        type_="check",
    )
    op.drop_constraint(
        "ck_execution_plans_source",
        "execution_plans",
        type_="check",
    )
    op.drop_constraint(
        "uq_execution_plans_decision_id",
        "execution_plans",
        type_="unique",
    )
    op.drop_constraint(
        "fk_execution_plans_decision_id_decisions",
        "execution_plans",
        type_="foreignkey",
    )
    op.drop_column("execution_plans", "decision_id")
    op.drop_column("execution_plans", "source")
