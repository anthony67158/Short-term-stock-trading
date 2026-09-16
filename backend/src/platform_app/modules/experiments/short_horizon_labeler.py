"""Deterministic short-horizon execution and outcome label simulation."""

from decimal import Decimal, ROUND_FLOOR

from platform_app.modules.experiments.cash_equity_fees import (
    CASH_EQUITY_FEE_POLICY,
    calculate_cash_equity_fees,
)

LABEL_SIMULATION_POLICY = {
    "policyVersion": "short-horizon-label-simulation.v1",
    "entryFillPrice": "LIMIT_PRICE",
    "pFillDefinition": "AT_LEAST_ONE_BOARD_LOT",
    "buyLotShares": 100,
    "tPlusOne": "ENTRY_SESSION_TRIGGER_EXECUTES_NEXT_SESSION_OPEN",
    "terminalPriceAuthority": "CANONICAL_DAILY_CLOSE",
    "marketExitSlippageBps": CASH_EQUITY_FEE_POLICY["marketExitSlippageBps"]["value"],
    "feePolicyVersion": CASH_EQUITY_FEE_POLICY["policyVersion"],
}


def _decimal(value) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError("LABEL_NUMBER_INVALID")
    return result


def _text(value: Decimal) -> str:
    rendered = format(value.normalize(), "f")
    return "0" if rendered in {"", "-0"} else rendered


def _exit_price(raw_price: Decimal) -> Decimal:
    slippage = Decimal(CASH_EQUITY_FEE_POLICY["marketExitSlippageBps"]["value"])
    return raw_price * (Decimal("1") - slippage / Decimal("10000"))


def _trigger(bar: dict, stop_price: Decimal, take_price: Decimal) -> str | None:
    low = _decimal(bar["low"])
    high = _decimal(bar["high"])
    if low <= stop_price:
        return "STOP"
    if high >= take_price:
        return "TAKE_PROFIT"
    return None


def simulate_buy_limit_episode(
    *,
    instrument_id: str,
    board: str,
    decision_date: str,
    trade_dates: list[str],
    decision_close: str,
    bars: list[dict],
    terminal_close: str,
    execution_policy: dict,
    label_policy: dict,
) -> dict:
    if (
        len(trade_dates) != 5
        or len(bars) != 240
        or any(
            sum(row["tradeDate"] == trade_date for row in bars) != 48
            for trade_date in trade_dates
        )
    ):
        raise ValueError("LABEL_EPISODE_PATH_INCOMPLETE")
    ordered = sorted(bars, key=lambda row: row["barEndShanghai"])
    if [row["tradeDate"] for row in ordered[:48]] != [trade_dates[0]] * 48:
        raise ValueError("LABEL_EPISODE_PATH_INVALID")

    limit = _decimal(decision_close)
    lot = LABEL_SIMULATION_POLICY["buyLotShares"]
    target_notional = _decimal(execution_policy["targetNotionalCny"])
    target_shares = int(
        (target_notional / limit / lot).to_integral_value(rounding=ROUND_FLOOR)
    ) * lot
    if target_shares <= 0:
        raise ValueError("LABEL_TARGET_BELOW_ONE_LOT")
    participation = _decimal(execution_policy["maximumBarParticipationRate"])
    stop_price = limit * (Decimal("1") + _decimal(label_policy["stopLossReturn"]))
    take_price = limit * (Decimal("1") + _decimal(label_policy["takeProfitReturn"]))

    filled_shares = 0
    queued_t1_trigger = None
    exit_reason = None
    exit_date = None
    raw_exit_price = None
    for row in ordered:
        trade_date = row["tradeDate"]
        if queued_t1_trigger and trade_date != trade_dates[0]:
            exit_reason = f"T1_DEFERRED_{queued_t1_trigger}"
            exit_date = trade_date
            raw_exit_price = _decimal(row["open"])
            break

        is_entry_window = (
            trade_date == trade_dates[0]
            and row["barEndShanghai"][-8:] <= "10:00:00"
        )
        if is_entry_window and queued_t1_trigger is None and _decimal(row["low"]) <= limit:
            available = int(
                (_decimal(row["volumeShares"]) * participation / lot).to_integral_value(
                    rounding=ROUND_FLOOR
                )
            ) * lot
            filled_shares += min(available, target_shares - filled_shares)

        if filled_shares <= 0:
            continue
        trigger = _trigger(row, stop_price, take_price)
        if not trigger:
            continue
        if trade_date == trade_dates[0]:
            queued_t1_trigger = trigger
            continue
        exit_reason = trigger
        exit_date = trade_date
        raw_exit_price = (
            min(_decimal(row["open"]), stop_price)
            if trigger == "STOP"
            else take_price
        )
        break

    fill_ratio = Decimal(filled_shares) / Decimal(target_shares)
    if filled_shares == 0:
        return {
            "instrumentId": instrument_id,
            "board": board,
            "decisionDate": decision_date,
            "pFillLabel": 0,
            "fillRatio": "0",
            "filledShares": 0,
            "targetShares": target_shares,
            "pWinGivenFillLabel": None,
            "netReturnGivenFill": None,
            "stopHazardLabel": None,
            "exitReason": "NO_FILL",
            "exitDate": None,
        }

    if raw_exit_price is None:
        exit_reason = "TERMINAL"
        exit_date = trade_dates[-1]
        raw_exit_price = _decimal(terminal_close)
    executed_exit_price = _exit_price(raw_exit_price)
    buy_gross = limit * filled_shares
    sell_gross = executed_exit_price * filled_shares
    buy_fees = calculate_cash_equity_fees(
        side="BUY",
        gross_amount=buy_gross,
        board=board,
        trade_date=trade_dates[0],
    )
    sell_fees = calculate_cash_equity_fees(
        side="SELL",
        gross_amount=sell_gross,
        board=board,
        trade_date=exit_date,
    )
    net_return = (
        sell_gross - sell_fees["totalCny"] - buy_gross - buy_fees["totalCny"]
    ) / (buy_gross + buy_fees["totalCny"])
    return {
        "instrumentId": instrument_id,
        "board": board,
        "decisionDate": decision_date,
        "pFillLabel": 1,
        "fillRatio": _text(fill_ratio),
        "filledShares": filled_shares,
        "targetShares": target_shares,
        "entryPrice": _text(limit),
        "exitPrice": _text(executed_exit_price),
        "pWinGivenFillLabel": int(net_return > 0),
        "netReturnGivenFill": _text(net_return),
        "stopHazardLabel": int(exit_reason in {"STOP", "T1_DEFERRED_STOP"}),
        "exitReason": exit_reason,
        "exitDate": exit_date,
        "buyFeesCny": _text(buy_fees["totalCny"]),
        "sellFeesCny": _text(sell_fees["totalCny"]),
    }
