from collections import defaultdict
from decimal import Decimal

from sqlalchemy import func, select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.kernel.trading import money, quantity_rule, trading_date, validate_order_quantity
from platform_app.modules.market.models import Instrument
from platform_app.modules.operations.models import Outbox
from platform_app.modules.portfolio.models import (
    Execution, ExecutionCorrection, ExecutionPlan, PlanEvent, PositionLot,
)
from platform_app.modules.portfolio.plan_contracts import PlanCancel, PlanInput, PlanPage, PlanView
from platform_app.modules.portfolio.service import PortfolioError, cash_total, fingerprint, owned_account

ACTIVE = ("CONFIRMED", "PARTIALLY_RECORDED")


def active_plans(db, account_id, now):
    return list(db.scalars(select(ExecutionPlan).where(
        ExecutionPlan.account_id == account_id, ExecutionPlan.status.in_(ACTIVE),
        ExecutionPlan.expires_at > now).order_by(ExecutionPlan.created_at, ExecutionPlan.id)))


def plan_view(plan, now=None):
    view = PlanView.model_validate(plan)
    if plan.status in ACTIVE and plan.expires_at <= (now or utcnow()):
        return view.model_copy(update={"status": "EXPIRED", "reserved_cash": Decimal(0),
                                       "reserved_shares": 0})
    return view


def emit(db, account, plan, kind, key, request_hash, reason="账户事实变化"):
    db.flush()
    view = PlanView.model_validate(plan)
    db.add(PlanEvent(
        account_id=account.id, plan_id=plan.id, account_version=account.version,
        revision=plan.revision, kind=kind, command_key=key, request_hash=request_hash,
        result=view.model_dump(mode="json"),
        reason=reason,
    ))
    db.add(Outbox(
        owner_id=account.owner_id, event_type="portfolio.changed", aggregate_id=account.id,
        payload={"schemaVersion": "1", "accountId": account.id,
                 "aggregateVersion": account.version, "planId": plan.id},
    ))
    return view


def receipt(db, account_id, key, body):
    event = db.scalar(select(PlanEvent).where(
        PlanEvent.account_id == account_id, PlanEvent.command_key == key))
    if event:
        if event.request_hash != fingerprint(body):
            raise PortfolioError("IDEMPOTENCY_CONFLICT", "同一请求编号对应不同计划操作")
        return PlanView.model_validate(event.result)


def create_plan(user_id: str, account_id: str, body: PlanInput, key: str):
    with sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        existing = receipt(db, account_id, "create:" + key, body)
        if existing:
            return existing
        if account.version != body.expected_version:
            raise PortfolioError("ACCOUNT_VERSION_CONFLICT", "账户已有变化，请刷新计划")
        from platform_app.modules.portfolio.reconciliation import reconcile
        if not reconcile(user_id, account_id, db_session=db).matches:
            raise PortfolioError("LEDGER_MISMATCH", "账本存在差异，请先核对", 422)
        now = utcnow()
        if not now < body.expires_at or trading_date(body.expires_at) != trading_date(now):
            raise PortfolioError("PLAN_EXPIRY", "人工计划有效期须在当前上海日期内且晚于当前时间", 422)
        instrument = db.get(Instrument, body.instrument_id)
        if not instrument:
            raise PortfolioError("INSTRUMENT_NOT_FOUND", "证券尚未建立档案", 422)
        plans = active_plans(db, account_id, now)
        if len(plans) >= 100:
            raise PortfolioError("PLAN_LIMIT", "未完成计划已达100条，请先整理", 422)
        sellable = db.scalar(select(func.coalesce(func.sum(
            PositionLot.remaining_quantity), 0)).where(
                PositionLot.account_id == account_id,
                PositionLot.instrument_id == body.instrument_id,
                PositionLot.acquired_date < trading_date(now)))
        reserved_shares = sum(plan.reserved_shares for plan in plans
                              if plan.instrument_id == body.instrument_id)
        try:
            rule = quantity_rule(instrument.exchange, instrument.board, trading_date(now))
            # Whole-account sellable quantity determines odd-lot eligibility.
            validate_order_quantity(rule, body.side, body.quantity_shares, sellable)
        except ValueError as exc:
            raise PortfolioError("PLAN_QUANTITY", str(exc), 422) from exc
        if body.limit_price != money(body.limit_price):
            raise PortfolioError("PLAN_PRICE_TICK", "A股限价须以0.01元递增", 422)
        reserve = money(body.limit_price * body.quantity_shares) + body.fee_budget
        if reserve >= Decimal("1000000000000000000"):
            raise PortfolioError("PLAN_AMOUNT", "计划金额超过支持范围", 422)
        if body.side == "BUY" and reserve > cash_total(db, account_id) - sum(
                plan.reserved_cash for plan in plans):
            raise PortfolioError("PLAN_CASH_RESERVED", "扣除其他计划预留后现金不足", 422)
        if body.side == "SELL" and body.quantity_shares > sellable - reserved_shares:
            raise PortfolioError("PLAN_SHARES_RESERVED", "扣除其他计划预留后可卖股数不足", 422)
        account.version += 1
        plan = ExecutionPlan(
            account_id=account_id, **body.model_dump(exclude={"expected_version"}),
            status="CONFIRMED", reserved_cash=reserve if body.side == "BUY" else Decimal(0),
            reserved_shares=body.quantity_shares if body.side == "SELL" else 0,
        )
        db.add(plan)
        return emit(db, account, plan, "CREATE", "create:" + key, fingerprint(body), body.reason)


def cancel_plan(user_id: str, account_id: str, plan_id: str, body: PlanCancel, key: str):
    with sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        existing = receipt(db, account_id, f"cancel:{plan_id}:{key}", body)
        if existing:
            return existing
        plan = db.get(ExecutionPlan, plan_id)
        if not plan or plan.account_id != account_id:
            raise PortfolioError("PLAN_NOT_FOUND", "计划不存在或无权访问", 404)
        if account.version != body.expected_version or plan.revision != body.expected_revision:
            raise PortfolioError("PLAN_VERSION_CONFLICT", "账户或计划已有变化，请刷新")
        if plan.status not in ACTIVE:
            raise PortfolioError("PLAN_TERMINAL", "计划已经结束")
        account.version += 1
        plan.status, plan.reserved_cash, plan.reserved_shares = "CANCELLED", Decimal(0), 0
        plan.revision += 1
        return emit(db, account, plan, "CANCEL", f"cancel:{plan_id}:{key}",
                    fingerprint(body), body.reason)


def refresh_reservations(db, account, changed_plan_id=None):
    """Real facts take priority. Invalid remaining reservations release atomically."""
    now = utcnow()
    if changed_plan_id:
        plan = db.get(ExecutionPlan, changed_plan_id)
        reversed_ids = select(ExecutionCorrection.execution_id).where(
            ExecutionCorrection.account_id == account.id)
        trades = list(db.scalars(select(Execution).where(
            Execution.account_id == account.id, Execution.plan_id == plan.id,
            Execution.id.not_in(reversed_ids))))
        plan.recorded_shares = sum(trade.quantity_shares for trade in trades)
        remaining = max(0, plan.quantity_shares - plan.recorded_shares)
        fees = sum((trade.total_fees for trade in trades), Decimal(0))
        if plan.status in ACTIVE or plan.status == "COMPLETED":
            if not remaining:
                plan.status = "COMPLETED"
            elif plan.status == "COMPLETED":
                # A correction does not silently recreate a completed broker intention.
                plan.status = "INVALIDATED"
            else:
                plan.status = "PARTIALLY_RECORDED" if plan.recorded_shares else "CONFIRMED"
        plan.reserved_cash = (
            money(remaining * plan.limit_price) + max(Decimal(0), plan.fee_budget - fees)
            if remaining and plan.side == "BUY" and plan.status in ACTIVE else Decimal(0))
        plan.reserved_shares = remaining if plan.side == "SELL" and plan.status in ACTIVE else 0
        plan.revision += 1
        emit(db, account, plan, "FACT", new_id(), "0" * 64)
    cash = cash_total(db, account.id)
    available = defaultdict(int)
    for lot in db.scalars(select(PositionLot).where(
        PositionLot.account_id == account.id, PositionLot.acquired_date < trading_date(now))):
        available[lot.instrument_id] += lot.remaining_quantity
    for plan in active_plans(db, account.id, now):
        if plan.reserved_cash <= cash and plan.reserved_shares <= available[plan.instrument_id]:
            cash -= plan.reserved_cash
            available[plan.instrument_id] -= plan.reserved_shares
            continue
        plan.status, plan.reserved_cash, plan.reserved_shares = "INVALIDATED", Decimal(0), 0
        plan.revision += 1
        emit(db, account, plan, "INVALIDATE", new_id(), "0" * 64)


def list_plans(user_id: str, account_id: str, before: str | None, limit: int):
    with sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        now = utcnow()
        reserved = sum((plan.reserved_cash for plan in active_plans(
            db, account_id, now)), Decimal(0))
        query = select(ExecutionPlan).where(ExecutionPlan.account_id == account_id)
        if before:
            query = query.where(ExecutionPlan.id < before)
        rows = list(db.scalars(query.order_by(ExecutionPlan.id.desc()).limit(limit + 1)))
        return PlanPage(
            plans=[plan_view(plan, now) for plan in rows[:limit]],
            next_cursor=rows[limit - 1].id if len(rows) > limit else None,
            account_version=account.version, reserved_cash=reserved,
            spendable_cash=cash_total(db, account_id) - reserved,
        )
