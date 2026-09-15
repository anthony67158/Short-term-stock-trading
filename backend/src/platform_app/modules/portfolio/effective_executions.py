"""Read corrected facts without mutating the original broker record."""
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import select

from platform_app.kernel.trading import money
from platform_app.modules.portfolio.correction_contracts import ReplacementFact
from platform_app.modules.portfolio.models import Execution, ExecutionCorrection


def apply_replacement(trade, replacement):
    values = {column.name: getattr(trade, column.name) for column in Execution.__table__.columns}
    if replacement is not None:
        fact = ReplacementFact.model_validate(replacement)
        gross = money(fact.price * fact.quantity_shares)
        fees = sum((fact.fees.commission, fact.fees.stamp_tax,
                    fact.fees.transfer_fee, fact.fees.other_fee), Decimal(0))
        values.update(
            quantity_shares=fact.quantity_shares, price=fact.price,
            fees=fact.fees.model_dump(mode="json"), gross_amount=gross, total_fees=fees,
            cash_delta=-gross - fees if trade.side == "BUY" else gross - fees,
        )
    return SimpleNamespace(**values)


def effective_trades(db, account_id):
    corrections = {row.execution_id: row for row in db.scalars(
        select(ExecutionCorrection).where(ExecutionCorrection.account_id == account_id))}
    trades = db.scalars(select(Execution).where(Execution.account_id == account_id)
                        .order_by(Execution.account_version))
    return [apply_replacement(trade, correction.replacement if correction else None)
            for trade in trades
            if (correction := corrections.get(trade.id)) is None
            or correction.replacement is not None]
