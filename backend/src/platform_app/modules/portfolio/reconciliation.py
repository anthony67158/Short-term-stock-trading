"""Independent read-only replay of immutable facts against current projections."""
from collections import defaultdict, deque
from contextlib import nullcontext
from decimal import ROUND_HALF_UP, Decimal
from types import SimpleNamespace

from pydantic import Field
from sqlalchemy import select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import Contract, Money, utcnow
from platform_app.kernel.trading import trading_date
from platform_app.modules.portfolio.models import (
    CashEntry,
    CorporateShareEvent,
    CustodyTransfer,
    Execution,
    ExecutionCorrection,
    ExecutionPlan,
    LotConsumption,
    OpeningLot,
    PlanEvent,
    PositionLot,
)
from platform_app.modules.portfolio.plan_contracts import PlanView
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
    opening_lot_count: int = 0
    transfer_count: int = 0
    corporate_share_event_count: int = 0
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
        openings = list(db.scalars(select(OpeningLot).where(
            OpeningLot.account_id == account_id).order_by(OpeningLot.account_version).limit(50_001)))
        if len(openings) > 50_000:
            raise PortfolioError("REPLAY_LIMIT", "期初批次超过即时核对上限", 422)
        transfers = list(db.scalars(select(CustodyTransfer).where(
            CustodyTransfer.account_id == account_id).limit(50_001)))
        if len(transfers) > 50_000:
            raise PortfolioError("REPLAY_LIMIT", "转托管记录超过即时核对上限", 422)
        corporate_events = list(
            db.scalars(
                select(CorporateShareEvent)
                .where(CorporateShareEvent.account_id == account_id)
                .order_by(CorporateShareEvent.account_version)
                .limit(50_001)
            )
        )
        if len(corporate_events) > 50_000:
            raise PortfolioError(
                "REPLAY_LIMIT",
                "送转股份记录超过即时核对上限",
                422,
            )
        consumptions = list(db.scalars(select(LotConsumption).join(
            Execution, Execution.id == LotConsumption.sell_execution_id,
        ).where(Execution.account_id == account_id)))
        corrections = list(db.scalars(select(ExecutionCorrection).where(
            ExecutionCorrection.account_id == account_id)))
        by_correction = {row.id: row for row in corrections}
        reversed_ids = {row.execution_id for row in corrections if row.replacement is None}
        replacements = {row.execution_id: row.replacement for row in corrections
                        if row.replacement is not None}
        plan_events = list(db.scalars(select(PlanEvent).where(
            PlanEvent.account_id == account_id).order_by(
                PlanEvent.account_version, PlanEvent.revision).limit(50_001)))
        if len(plan_events) > 50_000:
            raise PortfolioError("REPLAY_LIMIT", "计划记录超过即时核对上限", 422)
        plans = list(db.scalars(select(ExecutionPlan).where(ExecutionPlan.account_id == account_id)))
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

        timeline = sorted(
            [
                *[row for row in cash_rows if row.kind != "REVERSAL"],
                *openings,
                *transfers,
                *corporate_events,
            ],
            key=lambda row: row.account_version,
        )
        for previous, current in zip(timeline, timeline[1:]):
            check(current.id, "factChronology", True, current.effective_at >= previous.effective_at)

        expected_lots, expected_links, execution_deltas = {}, {}, {}
        corrected_deltas, corrected_quantities, corrected_fees = {}, {}, {}
        pending_lots = defaultdict(deque)
        opening_ids = {row.id for row in openings}
        transfer_ids = {row.id for row in transfers}
        for row in openings:
            expected_lots[row.id] = {
                "instrument": row.instrument_id, "date": row.acquired_date,
                "quantity": row.quantity_shares, "basis": row.cost_basis,
                "sequence": row.account_version,
            }
            pending_lots[row.instrument_id].append(row.id)
            check(row.id, "acquisitionBeforeSnapshot", True,
                  row.acquired_date <= trading_date(row.effective_at))
        last_opening_time = max((row.effective_at for row in openings), default=None)
        last_opening_version = max((row.account_version for row in openings), default=0)
        by_id = {trade.id: trade for trade in executions}
        # This replay deliberately does not call the write-side FIFO allocator.
        for trade in sorted(
            [*executions, *transfers, *corporate_events],
            key=lambda row: row.account_version,
        ):
            if isinstance(trade, CorporateShareEvent):
                allocated = 0
                seen = set()
                for allocation in trade.allocations:
                    lot_id = allocation.get("lotId")
                    quantity = allocation.get("quantityShares")
                    valid = (
                        isinstance(lot_id, str)
                        and lot_id not in seen
                        and type(quantity) is int
                        and quantity > 0
                    )
                    check(trade.id, "shareAllocationValid", True, valid)
                    if not valid:
                        continue
                    seen.add(lot_id)
                    allocated += quantity
                    lot = expected_lots.get(lot_id)
                    check(
                        trade.id,
                        f"shareAllocationLot:{lot_id}",
                        True,
                        lot is not None
                        and lot["instrument"] == trade.instrument_id,
                    )
                    if (
                        lot is not None
                        and lot["instrument"] == trade.instrument_id
                    ):
                        lot["quantity"] += quantity
                check(
                    trade.id,
                    "shareAllocationTotal",
                    trade.quantity_shares,
                    allocated,
                )
                continue
            if isinstance(trade, CustodyTransfer):
                expected_lots[trade.id] = {
                    "instrument": trade.instrument_id, "date": trade.acquired_date,
                    "quantity": trade.quantity_shares, "basis": trade.cost_basis,
                    "sequence": trade.account_version,
                }
                pending_lots[trade.instrument_id].append(trade.id)
                check(trade.id, "acquisitionBeforeTransfer", True,
                      trade.acquired_date <= trading_date(trade.effective_at))
                continue
            check(trade.id, "executionAfterOpening", True,
                  (last_opening_time is None or trade.executed_at >= last_opening_time)
                  and trade.account_version > last_opening_version)
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
            replacement = replacements.get(trade.id)
            if replacement is not None:
                # Independently decode and recompute; do not reuse write-side projection helpers.
                quantity = replacement["quantity_shares"]
                price = Decimal(replacement["price"])
                fee = sum((Decimal(replacement["fees"][key]) for key in (
                    "commission", "stamp_tax", "transfer_fee", "other_fee")), Decimal(0))
                gross = rounded(price * quantity)
                delta = -gross - fee if trade.side == "BUY" else gross - fee
                trade = SimpleNamespace(
                    **{column.name: getattr(trade, column.name)
                       for column in Execution.__table__.columns
                       if column.name != "quantity_shares"},
                    quantity_shares=quantity,
                )
            corrected_deltas[trade.id] = delta
            corrected_quantities[trade.id] = trade.quantity_shares
            corrected_fees[trade.id] = fee
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
            for buy_id in list(queue):
                lot = expected_lots[buy_id]
                if lot["date"] >= date:
                    continue
                taken = min(remaining, lot["quantity"])
                cost = lot["basis"] if taken == lot["quantity"] else rounded(
                    lot["basis"] * taken / lot["quantity"])
                expected_links[trade.id, buy_id] = (taken, cost)
                lot["quantity"] -= taken
                lot["basis"] -= cost
                if not lot["quantity"]:
                    queue.remove(buy_id)
                remaining -= taken
                basis += cost
                if not remaining:
                    break
            check(trade.id, "uncoveredSaleShares", 0, remaining)
            check(trade.id, "realizedPnl", delta - basis, trade.realized_pnl)

        actual_lots = {lot.id: lot for lot in lots}
        for buy_id in expected_lots.keys() | actual_lots.keys():
            expected, actual = expected_lots.get(buy_id), actual_lots.get(buy_id)
            if expected is None or actual is None:
                check(buy_id, "lotExists", expected is not None, actual is not None)
                continue
            check(buy_id, "executionLink",
                  None if buy_id in opening_ids | transfer_ids else buy_id, actual.execution_id)
            check(buy_id, "openingLink",
                  buy_id if buy_id in opening_ids else None, actual.opening_id)
            check(buy_id, "transferLink",
                  buy_id if buy_id in transfer_ids else None, actual.transfer_id)
            for field, column in [
                ("quantity", "remaining_quantity"), ("basis", "remaining_basis"),
                ("instrument", "instrument_id"), ("date", "acquired_date"), ("sequence", "sequence"),
            ]:
                check(buy_id, field, expected[field], getattr(actual, column))
        actual_links = {(row.sell_execution_id, row.lot_id): (row.quantity, row.basis)
                        for row in consumptions}
        for key in expected_links.keys() | actual_links.keys():
            check(":".join(key), "lotConsumption", expected_links.get(key), actual_links.get(key))

        actual_cash, replay_cash = Decimal(0), Decimal(0)
        linked = set()
        reversed_links = set()
        previous_time = None
        active_cash = Decimal(0)
        for row in cash_rows:
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
                active_cash += corrected_deltas.get(row.execution_id, Decimal(0))
            elif row.kind == "REVERSAL":
                reversed_links.add(row.correction_id)
                correction = by_correction.get(row.correction_id)
                check(row.id, "correctionExists", True, correction is not None)
                if correction:
                    original_delta = execution_deltas.get(correction.execution_id)
                    expected = (corrected_deltas.get(correction.execution_id, Decimal(0))
                                - original_delta if original_delta is not None else None)
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
        version_owners = {row.account_version: row.id for row in cash_rows}
        for row in [*openings, *transfers, *corporate_events]:
            check(row.id, "uniqueVersion", False, row.account_version in version_owners)
            version_owners[row.account_version] = row.id
        latest_events, revisions = {}, defaultdict(int)
        for event in plan_events:
            revisions[event.plan_id] += 1
            check(event.id, "planRevision", revisions[event.plan_id], event.revision)
            if event.kind in ("CREATE", "CANCEL", "EXPIRE"):
                check(event.id, "uniqueVersion", False, event.account_version in version_owners)
                version_owners[event.account_version] = event.id
            else:
                check(event.id, "factVersionExists", True, event.account_version in version_owners)
            latest_events[event.plan_id] = event
        for expected, actual in enumerate(sorted(version_owners), start=2):
            check(account_id, "versionSequence", expected, actual)
        check(account_id, "accountVersion", len(version_owners) + 1, account.version)
        current_cash_reservation = Decimal(0)
        current_share_reservations = defaultdict(int)
        now = utcnow()
        for plan in plans:
            event = latest_events.get(plan.id)
            check(plan.id, "planEventExists", True, event is not None)
            if event:
                check(plan.id, "planProjection", PlanView.model_validate(event.result),
                      PlanView.model_validate(plan))
            linked_trades = [trade for trade in executions
                             if trade.plan_id == plan.id and trade.id not in reversed_ids]
            shares = sum(corrected_quantities[trade.id] for trade in linked_trades)
            check(plan.id, "recordedShares", shares, plan.recorded_shares)
            remaining = max(0, plan.quantity_shares - shares)
            fees = sum((corrected_fees[trade.id] for trade in linked_trades), Decimal(0))
            active = plan.status in ("CONFIRMED", "PARTIALLY_RECORDED")
            reserved_cash = rounded(remaining * plan.limit_price) + max(
                Decimal(0), plan.fee_budget - fees) if remaining and active and (
                    plan.side == "BUY") else Decimal(0)
            check(plan.id, "reservedCash", reserved_cash, plan.reserved_cash)
            check(plan.id, "reservedShares",
                  remaining if active and plan.side == "SELL" else 0, plan.reserved_shares)
            if active and plan.expires_at > now:
                current_cash_reservation += reserved_cash
                if plan.side == "SELL":
                    current_share_reservations[plan.instrument_id] += remaining
        check(account_id, "cashReservationCovered", True, current_cash_reservation <= actual_cash)
        for instrument_id, quantity in current_share_reservations.items():
            available = sum(lot["quantity"] for lot in expected_lots.values()
                            if lot["instrument"] == instrument_id and lot["date"] < trading_date(now))
            check(instrument_id, "shareReservationCovered", True, quantity <= available)
        check(account_id, "cashBalance", replay_cash, actual_cash)
        check(account_id, "correctedCashBalance", active_cash, actual_cash)
        return ReconciliationView(
            account_version=account.version, cash_balance=actual_cash, replay_cash_balance=replay_cash,
            execution_count=len(executions), correction_count=len(corrections),
            opening_lot_count=len(openings), transfer_count=len(transfers),
            corporate_share_event_count=len(corporate_events), open_lot_count=sum(
                lot["quantity"] > 0 for lot in expected_lots.values()),
            discrepancy_count=count, discrepancies=issues, matches=count == 0,
        )
