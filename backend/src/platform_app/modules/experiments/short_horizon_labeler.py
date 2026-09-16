"""Deterministic short-horizon execution and outcome label simulation."""

from decimal import Decimal, ROUND_FLOOR

from platform_app.modules.experiments.cash_equity_fees import (
    CASH_EQUITY_FEE_POLICY,
    calculate_cash_equity_fees,
)

LABEL_SIMULATION_POLICY = {
    "policyVersion": "short-horizon-label-simulation.v2",
    "entryFillPrice": "LIMIT_PRICE",
    "pFillDefinition": "AT_LEAST_ONE_BOARD_LOT",
    "pFullFillDefinition": "REQUESTED_SHARES_FILLED",
    "buyLotShares": 100,
    "sizeAuthority": "REQUEST_CONTEXT_AND_ACCOUNT_CONSTRAINTS",
    "upstreamTargetNotionalRole": "REFERENCE_ONLY",
    "orderSizeScenarios": {
        "includeOneBoardLot": True,
        "referenceNotionalCny": "100000",
        "medianDailyAmountBps": ["5", "20", "100"],
    },
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


def order_size_scenarios(
    *,
    decision_close: str,
    median_amount20_cny: str,
) -> list[dict]:
    price = _decimal(decision_close)
    median_amount = _decimal(median_amount20_cny)
    lot = LABEL_SIMULATION_POLICY["buyLotShares"]
    if price <= 0 or median_amount <= 0:
        raise ValueError("ORDER_SIZE_SCENARIO_INPUT_INVALID")
    configured = LABEL_SIMULATION_POLICY["orderSizeScenarios"]
    requested = [("ONE_BOARD_LOT", price * lot)]
    requested.append(("REFERENCE_100K", _decimal(configured["referenceNotionalCny"])))
    requested.extend(
        (
            f"MEDIAN_AMOUNT_{basis_points}_BPS",
            median_amount * _decimal(basis_points) / Decimal("10000"),
        )
        for basis_points in configured["medianDailyAmountBps"]
    )
    by_shares: dict[int, list[str]] = {}
    for scenario_id, target_notional in requested:
        target_shares = int(
            (target_notional / price / lot).to_integral_value(rounding=ROUND_FLOOR)
        ) * lot
        if target_shares >= lot:
            by_shares.setdefault(target_shares, []).append(scenario_id)
    return [
        {
            "scenarioIds": scenario_ids,
            "reference100k": "REFERENCE_100K" in scenario_ids,
            "targetShares": target_shares,
            "targetNotionalCny": _text(price * target_shares),
            "targetToMedianAmount": _text(price * target_shares / median_amount),
        }
        for target_shares, scenario_ids in sorted(by_shares.items())
    ]


def simulate_buy_limit_path(
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
    participation = _decimal(execution_policy["maximumBarParticipationRate"])
    stop_price = limit * (Decimal("1") + _decimal(label_policy["stopLossReturn"]))
    take_price = limit * (Decimal("1") + _decimal(label_policy["takeProfitReturn"]))

    fill_capacity_shares = 0
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
            fill_capacity_shares += available

        if fill_capacity_shares <= 0:
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

    if fill_capacity_shares > 0 and raw_exit_price is None:
        exit_reason = "TERMINAL"
        exit_date = trade_dates[-1]
        raw_exit_price = _decimal(terminal_close)
    return {
        "instrumentId": instrument_id,
        "board": board,
        "decisionDate": decision_date,
        "entryDate": trade_dates[0],
        "entryPrice": _text(limit),
        "fillCapacityShares": fill_capacity_shares,
        "exitPrice": _text(_exit_price(raw_exit_price)) if raw_exit_price else None,
        "exitReason": exit_reason or "NO_FILL",
        "exitDate": exit_date,
    }


def label_order_scenario(path: dict, scenario: dict) -> dict:
    target_shares = scenario["targetShares"]
    filled_shares = min(path["fillCapacityShares"], target_shares)
    fill_ratio = Decimal(filled_shares) / Decimal(target_shares)
    base = {
        **path,
        **scenario,
        "pFillLabel": int(filled_shares >= LABEL_SIMULATION_POLICY["buyLotShares"]),
        "pFullFillLabel": int(filled_shares == target_shares),
        "fillRatio": _text(fill_ratio),
        "filledShares": filled_shares,
    }
    if filled_shares == 0:
        return {
            **base,
            "pWinGivenFillLabel": None,
            "netReturnGivenFill": None,
            "stopHazardLabel": None,
            "buyFeesCny": None,
            "sellFeesCny": None,
        }
    entry_price = _decimal(path["entryPrice"])
    exit_price = _decimal(path["exitPrice"])
    buy_gross = entry_price * filled_shares
    sell_gross = exit_price * filled_shares
    buy_fees = calculate_cash_equity_fees(
        side="BUY",
        gross_amount=buy_gross,
        board=path["board"],
        trade_date=path["entryDate"],
    )
    sell_fees = calculate_cash_equity_fees(
        side="SELL",
        gross_amount=sell_gross,
        board=path["board"],
        trade_date=path["exitDate"],
    )
    net_return = (
        sell_gross - sell_fees["totalCny"] - buy_gross - buy_fees["totalCny"]
    ) / (buy_gross + buy_fees["totalCny"])
    return {
        **base,
        "pWinGivenFillLabel": int(net_return > 0),
        "netReturnGivenFill": _text(net_return),
        "stopHazardLabel": int(path["exitReason"] in {"STOP", "T1_DEFERRED_STOP"}),
        "buyFeesCny": _text(buy_fees["totalCny"]),
        "sellFeesCny": _text(sell_fees["totalCny"]),
    }


def simulate_buy_limit_episode(
    *,
    target_shares: int,
    **path_arguments,
) -> dict:
    if (
        target_shares < LABEL_SIMULATION_POLICY["buyLotShares"]
        or target_shares % LABEL_SIMULATION_POLICY["buyLotShares"]
    ):
        raise ValueError("LABEL_TARGET_SHARES_INVALID")
    path = simulate_buy_limit_path(**path_arguments)
    scenario = {
        "scenarioIds": ["EXPLICIT_TARGET_SHARES"],
        "reference100k": False,
        "targetShares": target_shares,
        "targetNotionalCny": _text(_decimal(path["entryPrice"]) * target_shares),
        "targetToMedianAmount": None,
    }
    return label_order_scenario(path, scenario)
