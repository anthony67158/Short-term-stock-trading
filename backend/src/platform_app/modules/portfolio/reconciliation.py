"""Independent read-only replay of immutable facts against current projections."""
from collections import defaultdict, deque
from contextlib import nullcontext
from decimal import ROUND_HALF_UP, Decimal

from pydantic import Field
from sqlalchemy import select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import Contract, Money, utcnow
from platform_app.kernel.trading import trading_date
from platform_app.modules.portfolio.models import (
    CashEntry, Execution, ExecutionCorrection, LotConsumption, PositionLot,
)
from platform_app.modules.portfolio.service import PortfolioError, owned_account


class Discrepancy(Contract):
    reference: str
    field: str
    expected: str
    actual: str


class ReconciliationView(Contract):
    account_version: int
    cash_balance: Money
    replay_cash_balance: Money
    execution_count: int
    correction_count: int = 0
    open_lot_count: int
    discrepancy_count: int
    discrepancies: list[Discrepancy]
    matches: bool
    scope: str = "INTERNAL_LEDGER"
    checked_at: str = Field(default_factory=lambda: utcnow().isoformat())


def reconcile(user_id: str, account_id: str, *, db_session=None) -> ReconciliationView:
    with nullcontext(db_session) if db_session is not None else sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        cash_rows = list(db.scalars(select(CashEntry).where(
            CashEntry.account_id == account_id).order_by(CashEntry.account_version).limit(50_001)))
        if len(cash_rows) > 50_000:
            raise PortfolioError("REPLAY_LIMIT", "账本超过即时核对上限，请使用离线对账任务", 422)
        executions = list(db.scalars(select(Execution).where(
            Execution.account_id == account_id).order_by(Execution.account_version).limit(50_001)))
        if len(executions) > 50_000:
            raise PortfolioError("REPLAY_LIMIT", "成交超过即时核对上限，请使用离线对账任务", 422)
        lots = list(db.scalars(select(PositionLot).where(PositionLot.account_id == account_id)))
        consumptions = list(db.scalars(select(LotConsumption).join(
            Execution, Execution.id == LotConsumption.sell_execution_id,
        ).where(Execution.account_id == account_id)))
        corrections = list(db.scalars(select(ExecutionCorrection).where(
            ExecutionCorrection.account_id == account_id)))
        by_correction = {row.id: row for row in corrections}
        reversed_ids = {row.execution_id for row in corrections}
        issues: list[Discrepancy] = []
        count = 0

        def check(reference, field, expected, actual):
            nonlocal count
            if expected != actual:
                count += 1
                if len(issues) < 100:
                    issues.append(Discrepancy(reference=reference, field=field,
                                              expected=str(expected), actual=str(actual)))

        def rounded(value):
            return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

        expected_lots, expected_links, execution_deltas = {}, {}, {}
        pending_lots = defaultdict(deque)
        by_id = {trade.id: trade for trade in executions}
        # This replay deliberately does not call the write-side FIFO allocator.
        for trade in executions:
            gross = rounded(trade.price * trade.quantity_shares)
            fee = sum((Decimal(trade.fees[key]) for key in (
                "commission", "stamp_tax", "transfer_fee", "other_fee")), Decimal(0))
            delta = -gross - fee if trade.side == "BUY" else gross - fee
            execution_deltas[trade.id] = delta
            check(trade.id, "grossAmount", gross, trade.gross_amount)
            check(trade.id, "totalFees", fee, trade.total_fees)
            check(trade.id, "cashDelta", delta, trade.cash_delta)
            if trade.id in reversed_ids:
                check(trade.id, "realizedPnl", None, trade.realized_pnl)
                continue
            date = trading_date(trade.executed_at)
            if trade.side == "BUY":
                expected_lots[trade.id] = {
                    "instrument": trade.instrument_id, "date": date,
                    "quantity": trade.quantity_shares, "basis": -delta, "sequence": trade.account_version,
                }
                pending_lots[trade.instrument_id].append(trade.id)
                check(trade.id, "realizedPnl", None, trade.realized_pnl)
                continue
            remaining, basis = trade.quantity_shares, Decimal(0)
            queue = pending_lots[trade.instrument_id]
            while remaining and queue:
                buy_id = queue[0]
                lot = expected_lots[buy_id]
                if lot["date"] >= date:
                    break
                taken = min(remaining, lot["quantity"])
                cost = lot["basis"] if taken == lot["quantity"] else rounded(
                    lot["basis"] * taken / lot["quantity"])
                expected_links[trade.id, buy_id] = (taken, cost)
                lot["quantity"] -= taken
                lot["basis"] -= cost
                if not lot["quantity"]:
                    queue.popleft()
                remaining -= taken
                basis += cost
                if not remaining:
                    break
            check(trade.id, "uncoveredSaleShares", 0, remaining)
            check(trade.id, "realizedPnl", delta - basis, trade.realized_pnl)

        actual_lots = {lot.execution_id: lot for lot in lots}
        for buy_id in expected_lots.keys() | actual_lots.keys():
            expected, actual = expected_lots.get(buy_id), actual_lots.get(buy_id)
            if expected is None or actual is None:
                check(buy_id, "lotExists", expected is not None, actual is not None)
                continue
            for field, column in [
                ("quantity", "remaining_quantity"), ("basis", "remaining_basis"),
                ("instrument", "instrument_id"), ("date", "acquired_date"), ("sequence", "sequence"),
            ]:
                check(buy_id, field, expected[field], getattr(actual, column))
        actual_links = {(row.sell_execution_id, row.buy_execution_id): (row.quantity, row.basis)
                        for row in consumptions}
        for key in expected_links.keys() | actual_links.keys():
            check(":".join(key), "lotConsumption", expected_links.get(key), actual_links.get(key))

        actual_cash, replay_cash = Decimal(0), Decimal(0)
        linked = set()
        reversed_links = set()
        previous_time = None
        active_cash = Decimal(0)
        for version, row in enumerate(cash_rows, start=2):
            check(row.id, "accountVersion", version, row.account_version)
            if row.kind != "REVERSAL":
                if previous_time and row.effective_at < previous_time:
                    check(row.id, "chronological", True, False)
                previous_time = row.effective_at
            actual_cash += row.amount
            if row.kind == "EXECUTION":
                linked.add(row.execution_id)
                expected = execution_deltas.get(row.execution_id)
                check(row.id, "executionCash", expected, row.amount)
                if expected is not None:
                    replay_cash += expected
                trade = by_id.get(row.execution_id)
                if trade:
                    check(row.id, "executionVersion", trade.account_version, row.account_version)
                    check(row.id, "executionTime", trade.executed_at, row.effective_at)
                if row.execution_id not in reversed_ids and expected is not None:
                    active_cash += expected
            elif row.kind == "REVERSAL":
                reversed_links.add(row.correction_id)
                correction = by_correction.get(row.correction_id)
                check(row.id, "correctionExists", True, correction is not None)
                if correction:
                    original_delta = execution_deltas.get(correction.execution_id)
                    expected = -original_delta if original_delta is not None else None
                    check(row.id, "reversalCash", expected, row.amount)
                    check(row.id, "reversalFact", expected, correction.reversal_amount)
                    check(row.id, "correctionVersion", correction.account_version,
                          row.account_version)
                    check(row.id, "correctionTime", correction.recorded_at, row.effective_at)
                    trade = by_id.get(correction.execution_id)
                    check(row.id, "correctionAfterExecution", True, trade is not None
                          and correction.account_version > trade.account_version)
                    if expected is not None:
                        replay_cash += expected
            else:
                replay_cash += row.amount
                active_cash += row.amount
            if replay_cash < 0:
                check(row.id, "nonnegativeCash", True, False)
            if active_cash < 0:
                check(row.id, "correctedNonnegativeCash", True, False)
        for missing_id in by_correction.keys() - reversed_links:
            check(missing_id, "reversalEntryExists", True, False)
        for missing_id in execution_deltas.keys() - linked:
            check(missing_id, "cashEntryExists", True, False)
        check(account_id, "accountVersion", len(cash_rows) + 1, account.version)
        check(account_id, "cashBalance", replay_cash, actual_cash)
        check(account_id, "correctedCashBalance", active_cash, actual_cash)
        return ReconciliationView(
            account_version=account.version, cash_balance=actual_cash, replay_cash_balance=replay_cash,
            execution_count=len(executions), correction_count=len(corrections), open_lot_count=sum(
                lot["quantity"] > 0 for lot in expected_lots.values()),
            discrepancy_count=count, discrepancies=issues, matches=count == 0,
        )
