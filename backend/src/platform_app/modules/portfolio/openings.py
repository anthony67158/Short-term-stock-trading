"""Initial custody facts: no synthetic trade, fee, or cash movement."""
from sqlalchemy import func, select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import utcnow
from platform_app.kernel.trading import trading_date
from platform_app.modules.market.models import Instrument
from platform_app.modules.operations.models import Outbox
from platform_app.modules.portfolio.models import (
    CashEntry, CustodyTransfer, Execution, ExecutionPlan, OpeningLot, PositionLot,
)
from platform_app.modules.portfolio.opening_contracts import OpeningInput, OpeningPage, OpeningView
from platform_app.modules.portfolio.service import PortfolioError, fingerprint, owned_account


def last_fact_time(db, account_id):
    cash = db.scalar(select(func.max(CashEntry.effective_at)).where(
        CashEntry.account_id == account_id, CashEntry.kind != "REVERSAL"))
    opening = db.scalar(select(func.max(OpeningLot.effective_at)).where(
        OpeningLot.account_id == account_id))
    transfer = db.scalar(select(func.max(CustodyTransfer.effective_at)).where(
        CustodyTransfer.account_id == account_id))
    return max((value for value in (cash, opening, transfer) if value is not None), default=None)


def record_opening(user_id: str, account_id: str, body: OpeningInput, key: str):
    with sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        existing = db.scalar(select(OpeningLot).where(
            OpeningLot.account_id == account_id, OpeningLot.command_key == key))
        if existing:
            if existing.request_hash != fingerprint(body):
                raise PortfolioError("IDEMPOTENCY_CONFLICT", "同一请求编号对应不同期初持仓")
            return OpeningView.model_validate(existing)
        if account.version != body.expected_version:
            raise PortfolioError("ACCOUNT_VERSION_CONFLICT", "账户已有变化，请刷新后核对")
        if db.scalar(select(OpeningLot.id).where(
                OpeningLot.account_id == account_id, OpeningLot.source_key == body.source_key)):
            raise PortfolioError("OPENING_SOURCE_EXISTS", "此期初批次凭据已经录入")
        if (db.scalar(select(Execution.id).where(Execution.account_id == account_id).limit(1))
                or db.scalar(select(CustodyTransfer.id).where(
                    CustodyTransfer.account_id == account_id).limit(1))
                or db.scalar(select(ExecutionPlan.id).where(
                    ExecutionPlan.account_id == account_id).limit(1))):
            raise PortfolioError("OPENING_CLOSED", "已有成交或计划，不能追加期初；请使用迁移核对流程")
        if body.effective_at > utcnow() or body.acquired_date > trading_date(body.effective_at):
            raise PortfolioError("OPENING_DATE", "取得日不能晚于持仓基准日，基准时间不能在未来", 422)
        last = last_fact_time(db, account_id)
        if last and body.effective_at < last:
            raise PortfolioError("OPENING_ORDER", "期初持仓基准时间不能早于已有账户事实", 422)
        if not db.get(Instrument, body.instrument_id):
            raise PortfolioError("INSTRUMENT_NOT_FOUND", "证券尚未建立档案", 422)
        quantity, basis = db.execute(select(
            func.coalesce(func.sum(PositionLot.remaining_quantity), 0),
            func.coalesce(func.sum(PositionLot.remaining_basis), 0),
        ).where(PositionLot.account_id == account_id,
                PositionLot.instrument_id == body.instrument_id)).one()
        if quantity + body.quantity_shares > 1_000_000_000 or basis + body.cost_basis >= 10**18:
            raise PortfolioError("POSITION_LIMIT", "期初持仓数量或成本超过支持范围", 422)
        from platform_app.modules.portfolio.reconciliation import reconcile
        if not reconcile(user_id, account_id, db_session=db).matches:
            raise PortfolioError("LEDGER_MISMATCH", "账本存在差异，请先核对", 422)
        account.version += 1
        row = OpeningLot(account_id=account_id,
                         **body.model_dump(exclude={"expected_version"}),
                         account_version=account.version, command_key=key,
                         request_hash=fingerprint(body))
        db.add(row)
        db.flush()
        db.add(PositionLot(
            id=row.id, opening_id=row.id, account_id=account_id,
            instrument_id=row.instrument_id, acquired_date=row.acquired_date,
            remaining_quantity=row.quantity_shares, remaining_basis=row.cost_basis,
            sequence=account.version,
        ))
        db.add(Outbox(
            owner_id=user_id, event_type="portfolio.changed", aggregate_id=account_id,
            payload={"schemaVersion": "1", "accountId": account_id,
                     "aggregateVersion": account.version, "openingLotId": row.id},
        ))
        return OpeningView.model_validate(row)


def opening_history(user_id: str, account_id: str, before: int | None, limit: int):
    with sessions()() as db:
        owned_account(db, user_id, account_id)
        query = select(OpeningLot).where(OpeningLot.account_id == account_id)
        if before is not None:
            query = query.where(OpeningLot.account_version < before)
        rows = list(db.scalars(query.order_by(OpeningLot.account_version.desc()).limit(limit + 1)))
        return OpeningPage(lots=[OpeningView.model_validate(row) for row in rows[:limit]],
                           next_cursor=str(rows[limit - 1].account_version)
                           if len(rows) > limit else None)
