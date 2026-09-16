"""Capital-constrained replay for out-of-time quantitative selections."""

import math
from collections import Counter
from decimal import Decimal, ROUND_FLOOR

from platform_app.modules.experiments.cash_equity_fees import (
    calculate_cash_equity_fees,
)
from platform_app.modules.experiments.quant_model_trainer import QuantModelError
from platform_app.modules.experiments.short_horizon_labeler import (
    LABEL_SIMULATION_POLICY,
    label_order_scenario,
)

STRESS_COST = Decimal("0.001")


def _text(value: Decimal) -> str:
    rendered = format(value.quantize(Decimal("0.01")), "f")
    return "0.00" if rendered == "-0.00" else rendered


def _target_scenario(
    candidate: dict,
    *,
    slot_budget: Decimal,
    available_cash: Decimal,
) -> tuple[dict, Decimal] | None:
    price = Decimal(candidate["path"]["entryPrice"])
    lot = int(LABEL_SIMULATION_POLICY["buyLotShares"])
    budget = min(slot_budget, available_cash)
    target_shares = int(
        (budget / price / lot).to_integral_value(rounding=ROUND_FLOOR)
    ) * lot
    if target_shares < lot:
        target_shares = lot
    while target_shares >= lot:
        gross = price * target_shares
        fees = calculate_cash_equity_fees(
            side="BUY",
            gross_amount=gross,
            board=candidate["board"],
            trade_date=candidate["path"]["entryDate"],
        )["totalCny"]
        reservation = gross + fees
        if reservation <= available_cash:
            median_amount = Decimal(candidate["medianAmount20Cny"])
            return (
                {
                    "scenarioIds": ["ACCOUNT_SLOT"],
                    "reference100k": False,
                    "targetShares": target_shares,
                    "targetNotionalCny": format(gross, "f"),
                    "targetToMedianAmount": format(gross / median_amount, "f"),
                },
                reservation,
            )
        target_shares -= lot
    return None


def _predict_candidate(bundle, candidate: dict, scenario: dict) -> dict:
    scenario_values = [
        *candidate["baseFeatures"],
        math.log1p(float(scenario["targetNotionalCny"])),
        math.log1p(scenario["targetShares"]),
        math.log(max(float(scenario["targetToMedianAmount"]), 1e-12)),
    ]
    predictions = bundle.predict_matrix(
        base_values=[candidate["baseFeatures"]],
        scenario_values=[scenario_values],
    )
    result = {name: float(values[0]) for name, values in predictions.items()}
    result["utilityAt10BpsStress"] = result["pFill"] * (
        result["expectedNetReturnGivenFill"] - float(STRESS_COST)
    )
    return result


def _maximum_drawdown(values: list[Decimal]) -> float:
    peak = values[0]
    maximum = Decimal(0)
    for value in values:
        peak = max(peak, value)
        if peak > 0:
            maximum = max(maximum, (peak - value) / peak)
    return float(maximum)


def replay_account(
    *,
    candidates_by_date: dict[str, list[dict]],
    close_prices: dict[tuple[str, str], Decimal],
    bundle,
    initial_cash: Decimal,
    max_positions: int = 10,
) -> dict:
    if initial_cash <= 0 or max_positions <= 0:
        raise QuantModelError("ACCOUNT_REPLAY_POLICY_INVALID")
    cash = initial_cash
    stressed_cash = initial_cash
    slot_budget = initial_cash / max_positions
    pending = []
    positions = []
    trades = []
    equity_curve = []
    counters = Counter()
    max_concurrent = 0

    def process_events(trade_date: str) -> None:
        nonlocal cash, stressed_cash, pending, positions, max_concurrent
        entering = [order for order in pending if order["entryDate"] <= trade_date]
        pending = [order for order in pending if order["entryDate"] > trade_date]
        for order in entering:
            outcome = label_order_scenario(order["candidate"]["path"], order["scenario"])
            counters["ordersExecuted"] += 1
            if not outcome["pFillLabel"]:
                counters["noFill"] += 1
                continue
            entry_price = Decimal(outcome["entryPrice"])
            filled_shares = outcome["filledShares"]
            buy_gross = entry_price * filled_shares
            buy_fees = Decimal(outcome["buyFeesCny"])
            buy_cost = buy_gross + buy_fees
            if buy_cost > cash:
                raise QuantModelError("ACCOUNT_REPLAY_RESERVED_CASH_VIOLATION")
            cash -= buy_cost
            stressed_cash -= buy_cost
            positions.append(
                {
                    "instrumentId": outcome["instrumentId"],
                    "board": outcome["board"],
                    "entryDate": outcome["entryDate"],
                    "exitDate": outcome["exitDate"],
                    "filledShares": filled_shares,
                    "entryPrice": entry_price,
                    "exitPrice": Decimal(outcome["exitPrice"]),
                    "buyCost": buy_cost,
                    "sellFees": Decimal(outcome["sellFeesCny"]),
                    "stressCost": buy_gross * STRESS_COST,
                    "lastPrice": entry_price,
                    "prediction": order["prediction"],
                    "rankPosition": order["candidate"]["rankPosition"],
                }
            )
        max_concurrent = max(max_concurrent, len(positions))

        exiting = [position for position in positions if position["exitDate"] <= trade_date]
        positions = [
            position for position in positions if position["exitDate"] > trade_date
        ]
        for position in exiting:
            sell_gross = position["exitPrice"] * position["filledShares"]
            sell_net = sell_gross - position["sellFees"]
            cash += sell_net
            stressed_cash += sell_net - position["stressCost"]
            pnl = sell_net - position["buyCost"]
            trades.append(
                {
                    "instrumentId": position["instrumentId"],
                    "board": position["board"],
                    "entryDate": position["entryDate"],
                    "exitDate": position["exitDate"],
                    "filledShares": position["filledShares"],
                    "buyCostCny": _text(position["buyCost"]),
                    "sellNetCny": _text(sell_net),
                    "netPnlCny": _text(pnl),
                    "stressPnlCny": _text(pnl - position["stressCost"]),
                    "rankPosition": position["rankPosition"],
                    "predictedUtilityAt10BpsStress": position["prediction"][
                        "utilityAt10BpsStress"
                    ],
                }
            )

    for decision_date, candidates in sorted(candidates_by_date.items()):
        process_events(decision_date)
        for position in positions:
            close = close_prices.get((decision_date, position["instrumentId"]))
            if close is not None:
                position["lastPrice"] = close
        marked_value = sum(
            position["lastPrice"] * position["filledShares"]
            for position in positions
        )
        equity_curve.append(cash + marked_value)

        planning_cash = cash
        active = {
            row["instrumentId"] for row in positions
        } | {row["candidate"]["instrumentId"] for row in pending}
        available_slots = max_positions - len(active)
        for candidate in sorted(candidates, key=lambda row: row["rankPosition"]):
            if not candidate.get("path"):
                counters["unavailablePath"] += 1
                continue
            if candidate["instrumentId"] in active:
                counters["duplicatePosition"] += 1
                continue
            if available_slots <= 0:
                counters["positionLimit"] += 1
                continue
            target = _target_scenario(
                candidate,
                slot_budget=slot_budget,
                available_cash=planning_cash,
            )
            if target is None:
                counters["cashConstraint"] += 1
                continue
            scenario, reservation = target
            prediction = _predict_candidate(bundle, candidate, scenario)
            if prediction["utilityAt10BpsStress"] <= 0:
                counters["modelGateRejected"] += 1
                continue
            pending.append(
                {
                    "entryDate": candidate["path"]["entryDate"],
                    "candidate": candidate,
                    "scenario": scenario,
                    "prediction": prediction,
                }
            )
            planning_cash -= reservation
            active.add(candidate["instrumentId"])
            available_slots -= 1
            counters["ordersPlanned"] += 1

    process_events("99999999")
    if pending or positions:
        raise QuantModelError("ACCOUNT_REPLAY_OPEN_STATE_REMAINS")
    equity_curve.append(cash)
    net_profit = cash - initial_cash
    stress_profit = stressed_cash - initial_cash
    return {
        "initialCashCny": _text(initial_cash),
        "finalCashCny": _text(cash),
        "stressFinalCashCny": _text(stressed_cash),
        "netProfitCny": _text(net_profit),
        "stressNetProfitCny": _text(stress_profit),
        "netReturn": float(net_profit / initial_cash),
        "stressNetReturn": float(stress_profit / initial_cash),
        "maximumDrawdown": _maximum_drawdown(equity_curve),
        "maxConcurrentPositions": max_concurrent,
        "counts": dict(sorted(counters.items())),
        "trades": trades,
    }
