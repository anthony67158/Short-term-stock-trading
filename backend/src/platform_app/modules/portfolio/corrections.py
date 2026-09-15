"""Append-only voids with a complete, atomic projection rebuild."""
import hashlib
from dataclasses import replace
from decimal import Decimal

from sqlalchemy import delete, select

from platform_app.adapters.database import sessions
from platform_app.kernel.trading import Lot, consume_fifo, trading_date
from platform_app.modules.operations.models import Outbox
from platform_app.modules.portfolio.correction_contracts import (
    CorrectionCommit, CorrectionInput, CorrectionPage, CorrectionPreview, CorrectionView,
)
from platform_app.modules.portfolio.models import (
    CashEntry, Execution, ExecutionCorrection, LotConsumption, PositionLot,
)
from platform_app.modules.portfolio.reconciliation import reconcile
from platform_app.modules.portfolio.service import (
    PortfolioError, cash_total, fingerprint, owned_account,
)

LIMIT = Decimal("1000000000000000000")


def prepare(db, account, execution_id, body):
    if account.version != body.expected_version:
        raise PortfolioError("ACCOUNT_VERSION_CONFLICT", "账户已有新记录，请重新预览冲正")
    trade = db.get(Execution, execution_id)
    if not trade or trade.account_id != account.id:
        raise PortfolioError("EXECUTION_NOT_FOUND", "成交不存在或无权访问", 404)
    reversed_ids = set(db.scalars(select(ExecutionCorrection.execution_id).where(
        ExecutionCorrection.account_id == account.id)))
    if execution_id in reversed_ids:
        raise PortfolioError("EXECUTION_REVERSED", "此成交已冲正，请查阅冲正记录")
    if not reconcile(account.owner_id, account.id, db_session=db).matches:
        raise PortfolioError("LEDGER_MISMATCH", "账本存在核对差异，请先处理差异再冲正", 422)
    reversed_ids.add(execution_id)
    cash = list(db.scalars(select(CashEntry).where(
        CashEntry.account_id == account.id).order_by(CashEntry.account_version).limit(50_001)))
    trades = list(db.scalars(select(Execution).where(
        Execution.account_id == account.id).order_by(Execution.account_version).limit(50_001)))
    if max(len(cash), len(trades)) > 50_000:
        raise PortfolioError("REPLAY_LIMIT", "账本超过即时冲正上限，请使用离线处理", 422)
    balance = Decimal(0)
    for row in cash:
        if row.kind == "REVERSAL" or row.execution_id in reversed_ids:
            continue
        balance += row.amount
        if not 0 <= balance < LIMIT:
            raise PortfolioError(
                "CORRECTION_CASH_DEPENDENCY", "冲正会使后续现金越界，请先核对依赖的成交或出金", 422)
    lots, links, pnl, instruments, sequences = {}, [], {}, {}, {}
    for row in trades:
        pnl[row.id] = None
        if row.id in reversed_ids:
            continue
        date = trading_date(row.executed_at)
        if row.side == "BUY":
            lots[row.id] = Lot(row.id, date, row.quantity_shares, -row.cash_delta)
            instruments[row.id], sequences[row.id] = row.instrument_id, row.account_version
            same = [lot for key, lot in lots.items() if instruments[key] == row.instrument_id]
            if (sum(lot.quantity for lot in same) > 1_000_000_000
                    or sum(lot.basis for lot in same) >= LIMIT):
                raise PortfolioError("POSITION_LIMIT", "冲正后持仓数量或成本超过支持范围", 422)
            continue
        candidates = [lot for key, lot in lots.items()
                      if instruments[key] == row.instrument_id and lot.quantity]
        try:
            allocations = consume_fifo(candidates, row.quantity_shares, date)
        except ValueError as exc:
            raise PortfolioError(
                "CORRECTION_SALE_DEPENDENCY",
                "冲正会使后续卖出缺少可卖股份，请先核对依赖的卖出记录", 422,
            ) from exc
        basis = Decimal(0)
        for allocation in allocations:
            lot = lots[allocation.execution_id]
            lots[lot.execution_id] = replace(
                lot, quantity=lot.quantity - allocation.quantity, basis=lot.basis - allocation.basis)
            links.append((row.id, allocation))
            basis += allocation.basis
        pnl[row.id] = row.cash_delta - basis
    before = cash_total(db, account.id)
    if balance != before - trade.cash_delta:
        raise PortfolioError("LEDGER_MISMATCH", "现金分录不一致，请先对账", 422)
    fields = dict(
        execution_id=trade.id, account_version=account.version,
        cash_before=before, cash_after=balance, reversal_amount=-trade.cash_delta,
        open_shares_before=sum(db.scalars(select(PositionLot.remaining_quantity).where(
            PositionLot.account_id == account.id))),
        open_shares_after=sum(lot.quantity for lot in lots.values()),
        recalculated_sales=sum(row.side == "SELL" and row.realized_pnl != pnl[row.id]
                               for row in trades),
    )
    preview = CorrectionPreview(**fields, preview_hash="pending")
    # Bind confirmation to the account version, reason, target and monetary impact.
    preview.preview_hash = fingerprint(CorrectionInput.model_validate(
        {"reason": body.reason, "expectedVersion": body.expected_version}
    )) + ":" + fingerprint(preview)
    preview.preview_hash = hashlib.sha256(preview.preview_hash.encode()).hexdigest()
    return preview, lots, links, pnl, instruments, sequences, trades


def preview_correction(user_id: str, account_id: str, execution_id: str, body: CorrectionInput):
    with sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        return prepare(db, account, execution_id, body)[0]


def correct_execution(
    user_id: str, account_id: str, execution_id: str, body: CorrectionCommit, key: str,
) -> CorrectionView:
    with sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        existing = db.scalar(select(ExecutionCorrection).where(
            ExecutionCorrection.account_id == account_id, ExecutionCorrection.command_key == key))
        if existing:
            if existing.request_hash != fingerprint(body) or existing.execution_id != execution_id:
                raise PortfolioError("IDEMPOTENCY_CONFLICT", "同一请求编号对应不同冲正")
            return CorrectionView.model_validate(existing)
        preview, lots, links, pnl, instruments, sequences, trades = prepare(
            db, account, execution_id, body)
        if body.preview_hash != preview.preview_hash:
            raise PortfolioError("PREVIEW_CHANGED", "冲正预览已变化，请重新核对")
        account.version += 1
        correction = ExecutionCorrection(
            account_id=account_id, execution_id=execution_id, actor_id=user_id,
            reason=body.reason, command_key=key, request_hash=fingerprint(body),
            account_version=account.version, reversal_amount=preview.reversal_amount,
        )
        db.add(correction)
        db.flush()
        db.add(CashEntry(
            account_id=account_id, source_key=correction.id, request_hash=fingerprint(body),
            kind="REVERSAL", amount=preview.reversal_amount, source=body.reason,
            effective_at=correction.recorded_at, account_version=account.version,
            correction_id=correction.id,
        ))
        trade_ids = select(Execution.id).where(Execution.account_id == account_id)
        db.execute(delete(LotConsumption).where(LotConsumption.sell_execution_id.in_(trade_ids)))
        db.execute(delete(PositionLot).where(PositionLot.account_id == account_id))
        for lot in lots.values():
            db.add(PositionLot(
                execution_id=lot.execution_id, account_id=account_id,
                instrument_id=instruments[lot.execution_id], acquired_date=lot.acquired_date,
                remaining_quantity=lot.quantity, remaining_basis=lot.basis,
                sequence=sequences[lot.execution_id],
            ))
        for sell_id, allocation in links:
            db.add(LotConsumption(
                sell_execution_id=sell_id, buy_execution_id=allocation.execution_id,
                quantity=allocation.quantity, basis=allocation.basis,
            ))
        for row in trades:
            row.realized_pnl = pnl[row.id]  # Projection only; quantities/prices/fees stay immutable.
        db.add(Outbox(
            owner_id=user_id, event_type="portfolio.changed", aggregate_id=account_id,
            payload={"schemaVersion": "1", "accountId": account_id,
                     "aggregateVersion": account.version, "correctionId": correction.id},
        ))
        return CorrectionView.model_validate(correction)


def correction_history(user_id: str, account_id: str, before: int | None, limit: int):
    with sessions()() as db:
        owned_account(db, user_id, account_id)
        query = select(ExecutionCorrection).where(ExecutionCorrection.account_id == account_id)
        if before is not None:
            query = query.where(ExecutionCorrection.account_version < before)
        rows = list(db.scalars(query.order_by(
            ExecutionCorrection.account_version.desc()).limit(limit + 1)))
        return CorrectionPage(
            corrections=[CorrectionView.model_validate(row) for row in rows[:limit]],
            next_cursor=str(rows[limit - 1].account_version) if len(rows) > limit else None,
        )
