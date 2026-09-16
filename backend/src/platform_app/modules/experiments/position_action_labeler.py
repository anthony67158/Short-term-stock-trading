"""Paired counterfactual labels for position-management actions."""

from decimal import Decimal, ROUND_FLOOR

from platform_app.modules.experiments.cash_equity_fees import (
    CASH_EQUITY_FEE_POLICY,
    calculate_cash_equity_fees,
)

POSITION_ACTION_POLICY = {
    "policyVersion": "position-action-label.v1",
    "actions": ["HOLD", "ADD", "REDUCE", "EXIT"],
    "snapshot": "ENTRY_SESSION_CLOSE",
    "actionWindow": "NEXT_SESSION_FIRST_30_MINUTES",
    "terminalExit": "FIFTH_SESSION_CANONICAL_CLOSE",
    "currentQuantitySource": "FULLY_FILLED_EXECUTION_SCENARIO",
    "addQuantity": "CURRENT_QUANTITY",
    "reduceQuantity": "HALF_CURRENT_QUANTITY_ROUNDED_DOWN_TO_BOARD_LOT",
    "buyLotShares": 100,
    "maximumBarParticipationRate": "0.05",
    "marketSlippageBps": CASH_EQUITY_FEE_POLICY["marketExitSlippageBps"]["value"],
    "feePolicyVersion": CASH_EQUITY_FEE_POLICY["policyVersion"],
    "tieBreak": ["HOLD", "REDUCE", "EXIT", "ADD"],
}


def _decimal(value) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError("POSITION_ACTION_NUMBER_INVALID")
    return result


def _text(value: Decimal) -> str:
    rendered = format(value.normalize(), "f")
    return "0" if rendered in {"", "-0"} else rendered


def _fees(side: str, gross: Decimal, board: str, trade_date: str) -> Decimal:
    if gross == 0:
        return Decimal(0)
    return calculate_cash_equity_fees(
        side=side,
        gross_amount=gross,
        board=board,
        trade_date=trade_date,
    )["totalCny"]


def _sell_net(shares: int, price: Decimal, board: str, trade_date: str) -> Decimal:
    gross = price * shares
    return gross - _fees("SELL", gross, board, trade_date)


def _buy_cost(shares: int, price: Decimal, board: str, trade_date: str) -> Decimal:
    gross = price * shares
    return gross + _fees("BUY", gross, board, trade_date)


def action_window_capacity(bars: list[dict]) -> int:
    if len(bars) < 6:
        raise ValueError("POSITION_ACTION_WINDOW_INCOMPLETE")
    first_date = bars[0]["tradeDate"]
    window = [
        row
        for row in bars
        if row["tradeDate"] == first_date
        and row["barEndShanghai"][-8:] <= "10:00:00"
    ]
    if len(window) != 6:
        raise ValueError("POSITION_ACTION_WINDOW_INCOMPLETE")
    participation = _decimal(
        POSITION_ACTION_POLICY["maximumBarParticipationRate"]
    )
    lot = POSITION_ACTION_POLICY["buyLotShares"]
    capacity = sum(
        int(
            (_decimal(row["volumeShares"]) * participation / lot).to_integral_value(
                rounding=ROUND_FLOOR
            )
        )
        * lot
        for row in window
    )
    return capacity


def label_position_actions(
    *,
    board: str,
    current_shares: int,
    snapshot_price: str,
    action_date: str,
    action_open: str,
    action_bars: list[dict],
    terminal_date: str,
    terminal_close: str,
) -> dict:
    lot = POSITION_ACTION_POLICY["buyLotShares"]
    if current_shares < lot or current_shares % lot:
        raise ValueError("POSITION_ACTION_CURRENT_SHARES_INVALID")
    snapshot = _decimal(snapshot_price)
    action_raw = _decimal(action_open)
    terminal_raw = _decimal(terminal_close)
    if min(snapshot, action_raw, terminal_raw) <= 0:
        raise ValueError("POSITION_ACTION_PRICE_INVALID")
    slippage = _decimal(POSITION_ACTION_POLICY["marketSlippageBps"]) / Decimal(
        "10000"
    )
    sell_price = action_raw * (Decimal(1) - slippage)
    buy_price = action_raw * (Decimal(1) + slippage)
    terminal_sell_price = terminal_raw * (Decimal(1) - slippage)
    capacity = action_window_capacity(action_bars)

    def value_after_sell(requested_shares: int) -> tuple[Decimal, int]:
        sold = min(requested_shares, capacity)
        remaining = current_shares - sold
        value = _sell_net(sold, sell_price, board, action_date)
        value += _sell_net(
            remaining,
            terminal_sell_price,
            board,
            terminal_date,
        )
        return value, sold

    hold_value = _sell_net(
        current_shares,
        terminal_sell_price,
        board,
        terminal_date,
    )
    exit_value, exit_filled = value_after_sell(current_shares)
    reduce_target = (
        (current_shares // 2) // lot
    ) * lot
    reduce_value, reduce_filled = value_after_sell(reduce_target)
    add_target = current_shares
    add_filled = min(add_target, capacity)
    add_value = (
        -_buy_cost(add_filled, buy_price, board, action_date)
        + _sell_net(
            current_shares + add_filled,
            terminal_sell_price,
            board,
            terminal_date,
        )
    )
    values = {
        "HOLD": hold_value,
        "ADD": add_value,
        "REDUCE": reduce_value,
        "EXIT": exit_value,
    }
    denominator = snapshot * current_shares
    deltas = {
        action: (value - hold_value) / denominator
        for action, value in values.items()
    }
    tie_break = POSITION_ACTION_POLICY["tieBreak"]
    best_action = max(
        tie_break,
        key=lambda action: (deltas[action], -tie_break.index(action)),
    )
    return {
        "currentShares": current_shares,
        "snapshotPrice": _text(snapshot),
        "actionDate": action_date,
        "actionOpen": _text(action_raw),
        "terminalDate": terminal_date,
        "terminalClose": _text(terminal_raw),
        "actionCapacityShares": capacity,
        "actionFilledShares": {
            "HOLD": 0,
            "ADD": add_filled,
            "REDUCE": reduce_filled,
            "EXIT": exit_filled,
        },
        "actionValuesCny": {
            action: _text(value) for action, value in values.items()
        },
        "deltaReturnVsHold": {
            action: _text(value) for action, value in deltas.items()
        },
        "bestAction": best_action,
    }
