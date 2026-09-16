"""Mature prospective position samples against sealed market facts."""

import json
import sqlite3
from collections import Counter
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation, ROUND_FLOOR
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import select

from platform_app.adapters.database import sessions
from platform_app.modules.experiments.cash_equity_fees import (
    CASH_EQUITY_FEE_POLICY,
    calculate_cash_equity_fees,
)
from platform_app.modules.experiments.joint_bundle import _file_sha256
from platform_app.modules.learning.models import (
    ProspectiveOutcome,
    ProspectiveSample,
)
from platform_app.modules.portfolio.effective_executions import effective_trades
from platform_app.modules.portfolio.models import ExecutionPlan

OUTCOME_SIMULATION_POLICY_VERSION = "prospective-position-outcome.v1"
OUTCOME_SCHEMA_VERSION = "prospective-position-outcome.v1"
ACTUAL_OUTCOME_SCHEMA_VERSION = "actual-execution-outcome.v1"
ATTRIBUTION_SCHEMA_VERSION = "outcome-attribution.v1"
SHANGHAI = ZoneInfo("Asia/Shanghai")
MAXIMUM_BAR_PARTICIPATION_RATE = Decimal("0.05")


class OutcomeSettlementError(ValueError):
    pass


class OutcomeExclusion(ValueError):
    pass


def _decimal(value: object, code: str) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise OutcomeExclusion(code) from exc
    if not result.is_finite():
        raise OutcomeExclusion(code)
    return result


def _text(value: Decimal) -> str:
    rendered = format(value.quantize(Decimal("0.00000001")), "f")
    return "0.00000000" if rendered == "-0.00000000" else rendered


def _fees(side: str, shares: int, price: Decimal, board: str, trade_date: str) -> Decimal:
    if shares == 0:
        return Decimal(0)
    return calculate_cash_equity_fees(
        side=side,
        gross_amount=price * shares,
        board=board,
        trade_date=trade_date,
    )["totalCny"]


def _buy_cost(shares: int, price: Decimal, board: str, trade_date: str) -> Decimal:
    return price * shares + _fees("BUY", shares, price, board, trade_date)


def _sell_net(shares: int, price: Decimal, board: str, trade_date: str) -> Decimal:
    return price * shares - _fees("SELL", shares, price, board, trade_date)


def _read_market_dataset(root: Path) -> tuple[dict, Path]:
    manifest_path = root.expanduser().resolve() / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise OutcomeSettlementError("OUTCOME_MARKET_MANIFEST_INVALID") from exc
    if not isinstance(manifest, dict):
        raise OutcomeSettlementError("OUTCOME_MARKET_MANIFEST_INVALID")
    database = manifest_path.parent / str(manifest.get("database") or "")
    if (
        manifest.get("schemaVersion") != "market-dataset.v4"
        or not database.is_file()
        or _file_sha256(database) != manifest.get("databaseSha256")
    ):
        raise OutcomeSettlementError("OUTCOME_MARKET_DATASET_INVALID")
    return manifest, database


def _snapshot_identity(sample: ProspectiveSample, dataset_id: str) -> str:
    parts = sample.market_snapshot_ref.rsplit(":", maxsplit=2)
    if (
        len(parts) != 3
        or parts[0] != dataset_id
        or len(parts[1]) != 8
        or not parts[1].isdigit()
        or len(parts[2]) != 64
    ):
        raise OutcomeExclusion("MARKET_SNAPSHOT_REF_INVALID")
    return parts[1]


def _quantity(value: object, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 1_000_000_000:
        raise OutcomeExclusion(code)
    return value


def _action_targets(sample: ProspectiveSample) -> tuple[int, int, dict[str, int]]:
    current = _quantity(
        sample.context.get("currentQuantityShares"),
        "CURRENT_QUANTITY_INVALID",
    )
    sellable = _quantity(
        sample.context.get("sellableQuantityShares"),
        "SELLABLE_QUANTITY_INVALID",
    )
    values = sample.quant_prediction.get("values")
    if current == 0 or sellable > current or not isinstance(values, list):
        raise OutcomeExclusion("ACTION_VECTOR_INVALID")
    targets = {}
    for value in values:
        if not isinstance(value, dict):
            continue
        action = value.get("action")
        target = value.get(
            "targetQuantityShares",
            value.get("target_quantity_shares"),
        )
        if action in {"HOLD", "ADD", "REDUCE", "EXIT"}:
            if action in targets:
                raise OutcomeExclusion("ACTION_VECTOR_INVALID")
            targets[action] = _quantity(target, "ACTION_TARGET_INVALID")
    if (
        set(targets) != {"HOLD", "ADD", "REDUCE", "EXIT"}
        or targets["HOLD"] != current
        or targets["ADD"] <= current
        or not 0 < targets["REDUCE"] < current
        or targets["EXIT"] != 0
    ):
        raise OutcomeExclusion("ACTION_VECTOR_INVALID")
    return current, sellable, targets


def _market_inputs(
    market: sqlite3.Connection,
    sample: ProspectiveSample,
    dataset_id: str,
) -> dict:
    decision_date = _snapshot_identity(sample, dataset_id)
    terminal_date = sample.horizon_end_date.strftime("%Y%m%d")
    identity = market.execute(
        "SELECT board FROM instruments WHERE instrument_id=?",
        (sample.instrument_id,),
    ).fetchone()
    if identity is None:
        raise OutcomeExclusion("INSTRUMENT_FACT_MISSING")
    action_date_row = market.execute(
        "SELECT MIN(cal_date) FROM trade_calendar "
        "WHERE exchange='SSE' AND is_open=1 AND cal_date>?",
        (decision_date,),
    ).fetchone()
    action_date = str(action_date_row[0] or "")
    if not action_date or action_date > terminal_date:
        raise OutcomeExclusion("ACTION_SESSION_MISSING")
    bars = {}
    for label, trade_date in (
        ("decision", decision_date),
        ("action", action_date),
        ("terminal", terminal_date),
    ):
        row = market.execute(
            "SELECT open,close FROM daily_bars "
            "WHERE instrument_id=? AND trade_date=?",
            (sample.instrument_id, trade_date),
        ).fetchone()
        if row is None:
            raise OutcomeExclusion(f"{label.upper()}_DAILY_BAR_MISSING")
        bars[label] = row
    factors = market.execute(
        "SELECT trade_date,factor FROM adjustment_factors "
        "WHERE instrument_id=? AND trade_date IN (?,?,?)",
        (sample.instrument_id, decision_date, action_date, terminal_date),
    ).fetchall()
    factor_by_date = {
        row["trade_date"]: _decimal(
            row["factor"],
            "ADJUSTMENT_INVALID",
        )
        for row in factors
    }
    if set(factor_by_date) != {decision_date, action_date, terminal_date}:
        raise OutcomeExclusion("ADJUSTMENT_FACTOR_MISSING")
    if len(set(factor_by_date.values())) != 1:
        raise OutcomeExclusion("CORPORATE_ACTION_UNSUPPORTED")
    action_day = f"{action_date[:4]}-{action_date[4:6]}-{action_date[6:]}"
    minute_rows = market.execute(
        "SELECT bar_end_shanghai,volume_shares FROM minute_bars "
        "WHERE instrument_id=? AND substr(bar_end_shanghai,1,10)=? "
        "AND substr(bar_end_shanghai,-8)<='10:00:00' "
        "ORDER BY bar_end_shanghai",
        (sample.instrument_id, action_day),
    ).fetchall()
    if len(minute_rows) != 6:
        raise OutcomeExclusion("ACTION_MINUTE_WINDOW_INCOMPLETE")
    capacity = 0
    for row in minute_rows:
        volume = _decimal(row["volume_shares"], "MINUTE_VOLUME_INVALID")
        if volume < 0:
            raise OutcomeExclusion("MINUTE_VOLUME_INVALID")
        capacity += int(
            (
                volume
                * MAXIMUM_BAR_PARTICIPATION_RATE
                / Decimal(100)
            ).to_integral_value(rounding=ROUND_FLOOR)
        ) * 100
    return {
        "board": identity["board"],
        "decisionDate": decision_date,
        "actionDate": action_date,
        "terminalDate": terminal_date,
        "snapshotPrice": _decimal(bars["decision"]["close"], "SNAPSHOT_PRICE_INVALID"),
        "actionOpen": _decimal(bars["action"]["open"], "ACTION_PRICE_INVALID"),
        "terminalClose": _decimal(bars["terminal"]["close"], "TERMINAL_PRICE_INVALID"),
        "actionCapacityShares": capacity,
    }


def _simulate(sample: ProspectiveSample, inputs: dict) -> dict:
    current, sellable, targets = _action_targets(sample)
    snapshot = inputs["snapshotPrice"]
    action_open = inputs["actionOpen"]
    terminal = inputs["terminalClose"]
    if min(snapshot, action_open, terminal) <= 0:
        raise OutcomeExclusion("MARKET_PRICE_INVALID")
    slippage = Decimal(
        CASH_EQUITY_FEE_POLICY["marketExitSlippageBps"]["value"]
    ) / Decimal(10000)
    buy_price = action_open * (Decimal(1) + slippage)
    sell_price = action_open * (Decimal(1) - slippage)
    terminal_sell_price = terminal * (Decimal(1) - slippage)
    capacity = inputs["actionCapacityShares"]
    values = {}
    fills = {}
    for action, target in targets.items():
        if action == "HOLD":
            filled = 0
            value = _sell_net(
                current,
                terminal_sell_price,
                inputs["board"],
                inputs["terminalDate"],
            )
        elif action == "ADD":
            filled = min(target - current, capacity)
            value = -_buy_cost(
                filled,
                buy_price,
                inputs["board"],
                inputs["actionDate"],
            ) + _sell_net(
                current + filled,
                terminal_sell_price,
                inputs["board"],
                inputs["terminalDate"],
            )
        else:
            filled = min(current - target, sellable, capacity)
            value = _sell_net(
                filled,
                sell_price,
                inputs["board"],
                inputs["actionDate"],
            ) + _sell_net(
                current - filled,
                terminal_sell_price,
                inputs["board"],
                inputs["terminalDate"],
            )
        fills[action] = filled
        values[action] = value
    denominator = snapshot * current
    returns = {
        action: (value - denominator) / denominator
        for action, value in values.items()
    }
    return {
        "schemaVersion": OUTCOME_SCHEMA_VERSION,
        "decisionDate": inputs["decisionDate"],
        "actionDate": inputs["actionDate"],
        "terminalDate": inputs["terminalDate"],
        "currentShares": current,
        "sellableShares": sellable,
        "targetShares": targets,
        "snapshotPrice": _text(snapshot),
        "actionOpen": _text(action_open),
        "terminalClose": _text(terminal),
        "actionCapacityShares": capacity,
        "actionFilledShares": fills,
        "actionNetReturns": {
            action: _text(value) for action, value in returns.items()
        },
        "actionDeltaReturnsVsHold": {
            action: _text(value - returns["HOLD"])
            for action, value in returns.items()
        },
    }


def _selected_action(sample: ProspectiveSample) -> str:
    action = sample.scenario.get("selectedAction")
    if action in {"NONE", "WAIT"}:
        return "HOLD"
    if action not in {"HOLD", "ADD", "REDUCE", "EXIT"}:
        raise OutcomeExclusion("SELECTED_ACTION_INVALID")
    return action


def _actual_outcome(
    db,
    sample: ProspectiveSample,
    simulation: dict,
    inputs: dict,
) -> tuple[dict, dict, str | None]:
    selected = _selected_action(sample)
    selected_return = Decimal(simulation["actionNetReturns"][selected])
    plan = db.scalar(
        select(ExecutionPlan).where(
            ExecutionPlan.decision_id == sample.source_key,
        )
    )
    decision_action = sample.scenario.get("selectedAction")
    base = {
        "schemaVersion": ACTUAL_OUTCOME_SCHEMA_VERSION,
        "decisionAction": decision_action,
        "planId": plan.id if plan else None,
        "executionIds": [],
        "requestedShares": abs(
            simulation["targetShares"][selected] - simulation["currentShares"]
        ),
        "filledShares": 0,
        "fillRate": None,
        "weightedAveragePrice": None,
        "actualFeesCny": None,
        "actualNetReturn": None,
    }
    if decision_action in {"NONE", "WAIT"}:
        actual = {**base, "status": "DECISION_UNAVAILABLE"}
        reason = "DECISION_UNAVAILABLE"
        eligible = False
        actual_return = None
        first_execution_id = None
    elif selected == "HOLD":
        actual = {
            **base,
            "status": "NO_TRADE_REQUIRED",
            "fillRate": "1.00000000",
            "actualFeesCny": "0.00000000",
            "actualNetReturn": _text(selected_return),
        }
        reason = "NO_EXECUTION_REQUIRED"
        eligible = True
        actual_return = selected_return
        first_execution_id = None
    else:
        cutoff = datetime.combine(
            date.fromisoformat(
                f"{inputs['terminalDate'][:4]}-{inputs['terminalDate'][4:6]}-"
                f"{inputs['terminalDate'][6:]}"
            ),
            time(23, 59, 59, 999999),
            tzinfo=SHANGHAI,
        ).astimezone(UTC)
        trades = (
            [
                trade
                for trade in effective_trades(db, sample.account_id)
                if plan
                and trade.plan_id == plan.id
                and trade.executed_at <= cutoff
            ]
            if sample.account_id
            else []
        )
        if not trades:
            actual = {
                **base,
                "status": "NOT_EXECUTED",
            }
            reason = (
                "USER_DID_NOT_CREATE_PLAN"
                if plan is None
                else "USER_DID_NOT_RECORD_EXECUTION"
            )
            eligible = False
            actual_return = None
            first_execution_id = None
        else:
            side = "BUY" if selected == "ADD" else "SELL"
            if any(
                trade.side != side
                or trade.instrument_id != sample.instrument_id
                for trade in trades
            ):
                raise OutcomeExclusion("ACTUAL_EXECUTION_LINK_INVALID")
            filled = sum(trade.quantity_shares for trade in trades)
            requested = base["requestedShares"]
            gross = sum(
                (trade.price * trade.quantity_shares for trade in trades),
                Decimal(0),
            )
            fees = sum((trade.total_fees for trade in trades), Decimal(0))
            terminal_price = inputs["terminalClose"] * (
                Decimal(1)
                - Decimal(
                    CASH_EQUITY_FEE_POLICY["marketExitSlippageBps"]["value"]
                )
                / Decimal(10000)
            )
            ending_shares = (
                simulation["currentShares"] + filled
                if side == "BUY"
                else max(0, simulation["currentShares"] - filled)
            )
            cash_flow = sum((trade.cash_delta for trade in trades), Decimal(0))
            value = cash_flow + _sell_net(
                ending_shares,
                terminal_price,
                inputs["board"],
                inputs["terminalDate"],
            )
            denominator = inputs["snapshotPrice"] * simulation["currentShares"]
            actual_return = (value - denominator) / denominator
            reason = (
                "FULLY_EXECUTED"
                if filled == requested
                else "PARTIAL_EXECUTION"
                if filled < requested
                else "OVER_EXECUTION"
            )
            actual = {
                **base,
                "status": "EXECUTED",
                "executionIds": [trade.id for trade in trades],
                "side": side,
                "filledShares": filled,
                "fillRate": (
                    _text(Decimal(filled) / requested)
                    if requested
                    else None
                ),
                "weightedAveragePrice": _text(gross / filled),
                "actualFeesCny": _text(fees),
                "actualNetReturn": _text(actual_return),
            }
            eligible = True
            first_execution_id = trades[0].id
    attribution = {
        "schemaVersion": ATTRIBUTION_SCHEMA_VERSION,
        "strategyEvaluation": {
            "basis": "SEALED_COUNTERFACTUAL_SIMULATION",
            "selectedAction": selected,
            "netReturn": _text(selected_return),
            "deltaVsHold": simulation["actionDeltaReturnsVsHold"][selected],
            "isLoss": selected_return < 0,
        },
        "actualExecutionEvaluation": {
            "eligible": eligible,
            "failure": actual_return < 0 if actual_return is not None and eligible else None,
            "reason": reason,
            "executionDeltaVsSelectedAction": (
                _text(actual_return - selected_return)
                if actual_return is not None
                else None
            ),
        },
        "marketHoldReturn": simulation["actionNetReturns"]["HOLD"],
    }
    return actual, attribution, first_execution_id


def settle_prospective_outcomes(
    *,
    market_dataset_root: Path,
    as_of: datetime | None = None,
    owner_id: str | None = None,
    limit: int = 500,
) -> dict:
    if limit < 1 or limit > 10_000:
        raise OutcomeSettlementError("OUTCOME_SETTLEMENT_LIMIT_INVALID")
    now = as_of or datetime.now(UTC)
    if now.tzinfo is None:
        raise OutcomeSettlementError("OUTCOME_SETTLEMENT_AS_OF_TZ_REQUIRED")
    manifest, database = _read_market_dataset(market_dataset_root)
    connection = sqlite3.connect(
        f"{database.as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise OutcomeSettlementError("OUTCOME_MARKET_INTEGRITY_FAILED")
        dataset_end = str(
            connection.execute(
                "SELECT MAX(trade_date) FROM daily_bars"
            ).fetchone()[0]
            or ""
        )
        if len(dataset_end) != 8 or not dataset_end.isdigit():
            raise OutcomeSettlementError("OUTCOME_MARKET_DATASET_EMPTY")
        local_now = now.astimezone(SHANGHAI)
        observable_date = local_now.date()
        if local_now.time() < time(17):
            observable_date -= timedelta(days=1)
        eligible_end = min(
            dataset_end,
            observable_date.strftime("%Y%m%d"),
        )
        matured = 0
        excluded = Counter()
        with sessions().begin() as db:
            query = (
                select(ProspectiveSample)
                .where(
                    ProspectiveSample.status == "PENDING",
                    ProspectiveSample.horizon_end_date
                    <= date.fromisoformat(
                        f"{eligible_end[:4]}-{eligible_end[4:6]}-{eligible_end[6:]}"
                    ),
                )
                .order_by(
                    ProspectiveSample.horizon_end_date,
                    ProspectiveSample.id,
                )
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
            if owner_id is not None:
                query = query.where(ProspectiveSample.owner_id == owner_id)
            for sample in db.scalars(query):
                try:
                    inputs = _market_inputs(
                        connection,
                        sample,
                        manifest["datasetId"],
                    )
                    simulation = _simulate(sample, inputs)
                    actual, attribution, execution_id = _actual_outcome(
                        db,
                        sample,
                        simulation,
                        inputs,
                    )
                except OutcomeExclusion as exc:
                    sample.status = "EXCLUDED"
                    sample.matured_at = now
                    sample.exclusion_reason = str(exc)
                    excluded[str(exc)] += 1
                    continue
                db.add(
                    ProspectiveOutcome(
                        sample_id=sample.id,
                        simulation_policy_version=(
                            OUTCOME_SIMULATION_POLICY_VERSION
                        ),
                        source_dataset_id=manifest["datasetId"],
                        source_dataset_sha256=manifest["databaseSha256"],
                        simulation_outcome=simulation,
                        actual_execution_id=execution_id,
                        actual_execution_outcome=actual,
                        attribution=attribution,
                        matured_at=now,
                    )
                )
                sample.status = "MATURED"
                sample.matured_at = now
                matured += 1
        return {
            "schemaVersion": "outcome-settlement-run.v1",
            "asOf": now.astimezone(UTC).isoformat(),
            "sourceDataset": {
                "datasetId": manifest["datasetId"],
                "databaseSha256": manifest["databaseSha256"],
                "endDate": dataset_end,
            },
            "matured": matured,
            "excluded": sum(excluded.values()),
            "exclusionReasons": dict(sorted(excluded.items())),
        }
    finally:
        connection.close()
