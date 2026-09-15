import hashlib
from contextlib import nullcontext
from decimal import Decimal

from sqlalchemy import case, func, select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import utcnow
from platform_app.kernel.trading import Lot, consume_fifo, money, trading_date
from platform_app.modules.market.models import Instrument
from platform_app.modules.operations.models import Outbox
from platform_app.modules.portfolio.execution_contracts import (
    ExecutionInput, ExecutionPage, ExecutionView, PositionPage, PositionView,
)
from platform_app.modules.portfolio.models import (
    CashEntry, Execution, ExecutionCommand, ExecutionCorrection, ExecutionPlan,
    LotConsumption, PositionLot,
)
from platform_app.modules.portfolio.service import (
    PortfolioError, cash_total, fingerprint, owned_account,
)

LIMIT = Decimal("1000000000000000000")


def record_execution(
    user_id: str, account_id: str, body: ExecutionInput, key: str, *, db_session=None,
) -> ExecutionView:
    facts = body.model_dump_json(exclude={"expected_version"}, exclude_none=True)
    fact_hash = hashlib.sha256(facts.encode()).hexdigest()
    with nullcontext(db_session) if db_session is not None else sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        command = db.get(ExecutionCommand, (account_id, key))
        if command:
            if command.request_hash != fingerprint(body):
                raise PortfolioError("IDEMPOTENCY_CONFLICT", "同一请求编号对应不同成交")
            return ExecutionView.model_validate(command.result)
        existing = db.scalar(select(Execution).where(
            Execution.account_id == account_id, Execution.source_key == body.source_key,
        ))
        if existing:
            if db.scalar(select(ExecutionCorrection.id).where(
                ExecutionCorrection.execution_id == existing.id,
            )):
                raise PortfolioError("EXECUTION_REVERSED", "此交割编号已冲正，不能重复导入原记录")
            if existing.fact_hash != fact_hash:
                raise PortfolioError("IDEMPOTENCY_CONFLICT", "同一交割编号对应不同成交")
            db.add(ExecutionCommand(account_id=account_id, command_key=key,
                                    request_hash=fingerprint(body), execution_id=existing.id,
                                    result=ExecutionView.model_validate(existing).model_dump(
                                        mode="json")))
            return ExecutionView.model_validate(existing)
        if account.version != body.expected_version:
            raise PortfolioError("ACCOUNT_VERSION_CONFLICT", "账户已有新记录，请刷新后核对")
        if body.executed_at > utcnow():
            raise PortfolioError("FUTURE_EXECUTION", "不能将尚未发生的成交记为事实", 422)
        if not db.get(Instrument, body.instrument_id):
            raise PortfolioError("INSTRUMENT_NOT_FOUND", "证券尚未建立档案，请先核对代码", 422)
        if body.plan_id:
            plan = db.get(ExecutionPlan, body.plan_id)
            if not plan or plan.account_id != account_id:
                raise PortfolioError("PLAN_NOT_FOUND", "计划不存在或无权访问", 404)
            if plan.instrument_id != body.instrument_id or plan.side != body.side:
                raise PortfolioError("PLAN_FACT_MISMATCH", "成交股票或方向与关联计划不一致", 422)
        last = db.scalar(select(CashEntry).where(
            CashEntry.account_id == account_id, CashEntry.kind != "REVERSAL")
                         .order_by(CashEntry.account_version.desc()).limit(1))
        if last and body.executed_at < last.effective_at:
            raise PortfolioError("OUT_OF_ORDER_EXECUTION", "请按发生时间顺序录入成交和资金", 422)
        gross = money(body.price * body.quantity_shares)
        fees = sum((body.fees.commission, body.fees.stamp_tax,
                    body.fees.transfer_fee, body.fees.other_fee), Decimal(0))
        delta = -gross - fees if body.side == "BUY" else gross - fees
        if gross <= 0 or max(gross, fees, abs(delta)) >= LIMIT:
            raise PortfolioError("AMOUNT_RANGE", "成交金额或费用超出支持范围", 422)
        total = cash_total(db, account_id) + delta
        if total < 0:
            raise PortfolioError("INSUFFICIENT_CASH", "现金不足以支付成交和实际费用", 422)
        if total >= LIMIT:
            raise PortfolioError("BALANCE_LIMIT", "余额超过账户支持范围", 422)
        lots, consumed = [], []
        if body.side == "SELL":
            lots = list(db.scalars(select(PositionLot).where(
                PositionLot.account_id == account_id,
                PositionLot.instrument_id == body.instrument_id,
                PositionLot.remaining_quantity > 0,
            ).order_by(PositionLot.sequence)))
            try:
                consumed = consume_fifo([
                    Lot(lot.execution_id, lot.acquired_date,
                        lot.remaining_quantity, lot.remaining_basis) for lot in lots
                ], body.quantity_shares, trading_date(body.executed_at))
            except ValueError as exc:
                raise PortfolioError("INSUFFICIENT_SELLABLE", str(exc), 422) from exc
        else:
            quantity = db.scalar(select(func.coalesce(func.sum(
                PositionLot.remaining_quantity), 0)).where(
                    PositionLot.account_id == account_id,
                    PositionLot.instrument_id == body.instrument_id))
            if quantity + body.quantity_shares > 1_000_000_000:
                raise PortfolioError("POSITION_LIMIT", "持仓数量超出支持范围", 422)
            basis = db.scalar(select(func.coalesce(func.sum(
                PositionLot.remaining_basis), 0)).where(
                    PositionLot.account_id == account_id,
                    PositionLot.instrument_id == body.instrument_id))
            if basis - delta >= LIMIT:
                raise PortfolioError("POSITION_LIMIT", "持仓成本超出支持范围", 422)
        account.version += 1
        execution = Execution(
            account_id=account_id, instrument_id=body.instrument_id, command_key=key,
            source_key=body.source_key, request_hash=fingerprint(body), fact_hash=fact_hash,
            side=body.side, quantity_shares=body.quantity_shares, price=body.price,
            gross_amount=gross, total_fees=fees, fees=body.fees.model_dump(mode="json"),
            cash_delta=delta, executed_at=body.executed_at, source=body.source,
            account_version=account.version,
            plan_id=body.plan_id,
            realized_pnl=delta - sum((item.basis for item in consumed), Decimal(0))
            if body.side == "SELL" else None,
        )
        db.add(execution)
        db.flush()
        db.add(ExecutionCommand(account_id=account_id, command_key=key,
                                request_hash=fingerprint(body), execution_id=execution.id,
                                result=ExecutionView.model_validate(execution).model_dump(
                                    mode="json")))
        db.add(CashEntry(
            account_id=account_id, source_key=execution.id, request_hash=fingerprint(body),
            kind="EXECUTION", amount=delta, source=body.source, effective_at=body.executed_at,
            account_version=account.version, execution_id=execution.id,
        ))
        if body.side == "BUY":
            db.add(PositionLot(
                execution_id=execution.id, account_id=account_id,
                instrument_id=body.instrument_id, acquired_date=trading_date(body.executed_at),
                remaining_quantity=body.quantity_shares, remaining_basis=-delta,
                sequence=account.version,
            ))
        else:
            by_id = {lot.execution_id: lot for lot in lots}
            for item in consumed:
                lot = by_id[item.execution_id]
                lot.remaining_quantity -= item.quantity
                lot.remaining_basis -= item.basis
                db.add(LotConsumption(
                    sell_execution_id=execution.id, buy_execution_id=item.execution_id,
                    quantity=item.quantity, basis=item.basis,
                ))
        db.flush()
        from platform_app.modules.portfolio.plans import refresh_reservations
        refresh_reservations(db, account, body.plan_id)
        db.add(Outbox(
            owner_id=user_id, event_type="portfolio.changed", aggregate_id=account_id,
            payload={"schemaVersion": "1", "accountId": account_id,
                     "aggregateVersion": account.version, "executionId": execution.id},
        ))
        return ExecutionView.model_validate(execution)


def execution_history(user_id: str, account_id: str, before: int | None, limit: int):
    with sessions()() as db:
        owned_account(db, user_id, account_id)
        query = select(Execution).where(Execution.account_id == account_id)
        if before is not None:
            query = query.where(Execution.account_version < before)
        rows = list(db.scalars(query.order_by(Execution.account_version.desc()).limit(limit + 1)))
        corrections = dict(db.execute(select(
            ExecutionCorrection.execution_id, ExecutionCorrection.id,
        ).where(ExecutionCorrection.account_id == account_id,
                ExecutionCorrection.execution_id.in_([row.id for row in rows]))).all())
        return ExecutionPage(
            executions=[ExecutionView.model_validate(row).model_copy(
                update={"correction_id": corrections.get(row.id)}) for row in rows[:limit]],
            next_cursor=str(rows[limit - 1].account_version) if len(rows) > limit else None,
        )


def positions(user_id: str, account_id: str, after: str | None, limit: int):
    with sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        now = utcnow()
        query = select(
            PositionLot.instrument_id, Instrument.name,
            func.sum(PositionLot.remaining_quantity).label("quantity"),
            func.sum(PositionLot.remaining_basis).label("basis"),
            func.sum(case((PositionLot.acquired_date < trading_date(now),
                           PositionLot.remaining_quantity), else_=0)).label("sellable"),
        ).join(Instrument).where(
            PositionLot.account_id == account_id, PositionLot.remaining_quantity > 0,
        )
        if after:
            query = query.where(PositionLot.instrument_id > after)
        rows = db.execute(query.group_by(PositionLot.instrument_id, Instrument.name)
                          .order_by(PositionLot.instrument_id).limit(limit + 1)).all()
        return PositionPage(
            positions=[PositionView(
                instrument_id=row.instrument_id, name=row.name, quantity_shares=row.quantity,
                sellable_shares=row.sellable, locked_shares=row.quantity - row.sellable,
                remaining_basis=row.basis,
            ) for row in rows[:limit]],
            next_cursor=rows[limit - 1].instrument_id if len(rows) > limit else None,
            account_version=account.version, as_of=now,
        )
