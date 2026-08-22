"""Event-driven A-share research backtest for StrategySpec v2."""

import argparse
import gzip
import json
import math
import os
import statistics

from ashare_execution import can_fill_open, price_limit_pct, trade_fees
from strategy_contract_v2 import load_strategy_spec_v2, validate_strategy_spec_v2


SCHEMA_VERSION = "strategy-backtest.v2"


def _finite(value, default=None):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _rounded(value, digits=6):
    if value is None:
        return None
    return round(float(value), digits)


def _field_value(context, field):
    current = context
    for key in field.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _rule_passed(actual, operator, expected):
    if actual is None:
        return False
    if operator == "EQ":
        return actual == expected
    if operator == "NE":
        return actual != expected
    if operator == "IN":
        return actual in expected
    if operator == "BETWEEN":
        value = _finite(actual)
        return (
            value is not None
            and float(expected[0]) <= value <= float(expected[1])
        )
    value = _finite(actual)
    threshold = _finite(expected)
    if value is None or threshold is None:
        return False
    return {
        "GT": value > threshold,
        "GTE": value >= threshold,
        "LT": value < threshold,
        "LTE": value <= threshold,
    }.get(operator, False)


def _evaluate(node, context):
    if node.get("type"):
        children = [_evaluate(child, context) for child in node["conditions"]]
        return all(children) if node["type"] == "ALL" else any(children)
    return _rule_passed(
        _field_value(context, node["field"]),
        node["op"],
        node.get("value"),
    )


def _validate_dataset(dataset, timeframe):
    if not isinstance(dataset, dict):
        raise ValueError("dataset must be an object")
    if dataset.get("schemaVersion") != "strategy-dataset.v2":
        raise ValueError("unsupported strategy dataset schema")
    if (dataset.get("quality") or {}).get("usable") is not True:
        raise ValueError("strategy dataset failed quality gate")
    manifest = dataset.get("manifest") or {}
    if manifest.get("timeframe") != timeframe:
        raise ValueError("dataset timeframe does not match strategy")
    if manifest.get("priceStreams") != {
        "signal": "QFQ",
        "execution": "RAW",
    }:
        raise ValueError("dataset must declare QFQ signal and RAW execution")
    bars = dataset.get("bars")
    if not isinstance(bars, list) or not bars:
        raise ValueError("strategy dataset contains no bars")
    seen = set()
    for bar in bars:
        if bar.get("barClosed") is not True:
            raise ValueError("backtest accepts completed bars only")
        if (bar.get("signalPrice") or {}).get("adjustment") != "QFQ":
            raise ValueError("signal price stream must be QFQ")
        if (bar.get("executionPrice") or {}).get("adjustment") != "RAW":
            raise ValueError("execution price stream must be RAW")
        key = (str(bar.get("timestamp")), str(bar.get("code")))
        if key in seen:
            raise ValueError("duplicate timestamp/code bar")
        seen.add(key)
    return sorted(
        (dict(bar) for bar in bars),
        key=lambda item: (str(item["timestamp"]), str(item["code"])),
    )


def _group_bars(bars):
    grouped = {}
    for bar in bars:
        grouped.setdefault(str(bar["timestamp"]), {})[bar["code"]] = bar
    return grouped


def _is_liquid(spec, bar):
    limits = spec["liquidityLimits"]
    return (
        bar.get("isSt") is False
        and bar.get("isSuspended") is False
        and (_finite(bar.get("amount"), 0) >= float(limits["minimumAmount"]))
        and (_finite(bar.get("adv20"), 0) >= float(limits["minimumAdv20"]))
        and (_finite(bar.get("listingDays"), 0) >= spec["data"]["minimumHistoryBars"])
        and (_finite(bar.get("volume"), 0) > 0)
    )


def _signal_context(bar):
    return {
        **bar,
        "market": {"regime": bar.get("marketRegime", "UNKNOWN")},
        "account": {
            "hasBasePosition": bool(bar.get("hasBasePosition")),
        },
    }


def _combined_score(spec, bar):
    aliases = {
        "fund": bar.get("fund", {}).get("mainRatio", bar.get("mainRatio")),
        "liquidity": min(
            100.0,
            max(
                0.0,
                math.log10(max(_finite(bar.get("adv20"), 1.0), 1.0))
                / 10.0
                * 100.0,
            ),
        ),
        "marketScore": bar.get("marketScore"),
        "meanReversion": (
            100.0 - abs(_finite(bar.get("technical", {}).get("rsi6"), 50) - 30)
        ),
        "quantScore": (bar.get("quant") or {}).get("score"),
        "relativeStrength": bar.get("relativeStrength20"),
        "relativeWeakness": 100.0 - _finite(bar.get("relativeStrength20"), 50),
        "sectorBreadth": (bar.get("sector") or {}).get("breadth"),
        "structureBreak": (
            100.0 if (bar.get("technical") or {}).get("structureBreak") else 0.0
        ),
        "trend": (
            100.0 if (bar.get("technical") or {}).get("donchianBreakout") else 0.0
        ),
        "vwap": 100.0 - min(
            100.0,
            abs(_finite(
                (bar.get("technical") or {}).get("vwapDeviationPct"),
                0,
            )) * 20.0,
        ),
        "volatility": 100.0 - min(
            100.0,
            _finite((bar.get("technical") or {}).get("atrPct"), 0) * 15.0,
        ),
        "volume": min(100.0, _finite(bar.get("volRatio"), 0) * 40.0),
    }
    return _rounded(sum(
        max(0.0, min(100.0, _finite(aliases.get(name), 0.0)))
        * float(weight)
        for name, weight in spec["score"]["weights"].items()
    ))


def _effective_fill(raw_price, side, quantity, volume, spec, stress_bps):
    base_participation = float(
        spec["capacityAssumptions"]["baseParticipationRate"]
    )
    participation = quantity / max(float(volume), 1.0)
    impact_bps = 20.0 * math.sqrt(
        max(0.0, participation) / base_participation
    )
    total_bps = (
        float(stress_bps)
        + float(spec["execution"]["spreadBps"]) / 2.0
        + impact_bps
    )
    direction = 1.0 if side == "BUY" else -1.0
    price = float(raw_price) * (1.0 + direction * total_bps / 10_000.0)
    return {
        "price": price,
        "participationRate": participation,
        "slippageBps": total_bps,
        "impactCost": abs(price - float(raw_price)) * quantity,
    }


def _capacity_quantity(spec, bar):
    volume = max(0.0, _finite(bar.get("volume"), 0.0))
    rate = min(
        float(spec["liquidityLimits"]["maximumParticipationRate"]),
        float(spec["capacityAssumptions"]["baseParticipationRate"]),
    )
    lot = int(spec["positionSizing"]["lotSize"])
    volume_capacity = int(volume * rate // lot) * lot
    open_price = _finite((bar.get("executionPrice") or {}).get("open"), 0.0)
    adv_notional = max(0.0, _finite(bar.get("adv20"), 0.0)) * rate
    adv_capacity = (
        int(adv_notional / open_price // lot) * lot
        if open_price > 0
        else 0
    )
    return max(0, min(volume_capacity, adv_capacity))


def _can_fill(side, bar):
    execution = bar["executionPrice"]
    if bar.get("isSuspended") or _finite(bar.get("volume"), 0) <= 0:
        return False, "SUSPENDED_OR_NO_LIQUIDITY"
    previous = _finite(execution.get("previousClose"))
    open_price = _finite(execution.get("open"))
    if previous is None or open_price is None:
        return False, "INVALID_MARKET_DATA"
    allowed = can_fill_open(
        side=side.lower(),
        previous_close=previous,
        open_price=open_price,
        volume=bar["volume"],
        limit_pct=price_limit_pct(
            bar["code"],
            bar["date"],
            is_st=bar.get("isSt") is True,
        ),
    )
    if allowed:
        return True, None
    lower_side = "LIMIT_UP" if side == "BUY" else "LIMIT_DOWN"
    return False, lower_side


def _maximum_drawdown(equity_curve):
    peak = 0.0
    worst = 0.0
    for item in equity_curve:
        equity = float(item["equity"])
        peak = max(peak, equity)
        if peak > 0:
            worst = min(worst, equity / peak - 1.0)
    return worst


def _drawdown_recovery_bars(equity_curve):
    peak = None
    peak_index = 0
    worst_depth = 0.0
    worst_peak = None
    worst_trough_index = None
    for index, item in enumerate(equity_curve):
        equity = float(item["equity"])
        if peak is None or equity >= peak:
            peak = equity
            peak_index = index
        depth = equity / peak - 1.0 if peak else 0.0
        if depth < worst_depth:
            worst_depth = depth
            worst_peak = (peak_index, peak)
            worst_trough_index = index
    if worst_trough_index is None or worst_peak is None:
        return 0
    for index in range(worst_trough_index + 1, len(equity_curve)):
        if float(equity_curve[index]["equity"]) >= worst_peak[1]:
            return index - worst_peak[0]
    return None


def _risk_ratios(equity_curve, periods_per_year):
    if len(equity_curve) < 2:
        return None, None
    returns = []
    for previous, current in zip(equity_curve, equity_curve[1:]):
        before = float(previous["equity"])
        if before > 0:
            returns.append(float(current["equity"]) / before - 1.0)
    if not returns:
        return None, None
    mean = statistics.fmean(returns)
    deviation = statistics.pstdev(returns)
    downside = [min(0.0, value) for value in returns]
    downside_deviation = math.sqrt(
        sum(value * value for value in downside) / len(downside)
    )
    scale = math.sqrt(periods_per_year)
    sharpe = mean / deviation * scale if deviation > 0 else None
    sortino = (
        mean / downside_deviation * scale
        if downside_deviation > 0
        else None
    )
    return _rounded(sharpe), _rounded(sortino)


def run_strategy_backtest_v2(
    strategy_spec,
    dataset,
    *,
    initial_cash=1_000_000,
    slippage_bps=None,
    benchmarks=None,
):
    spec = validate_strategy_spec_v2(strategy_spec)
    cash = _finite(initial_cash)
    if cash is None or cash <= 0:
        raise ValueError("initial_cash must be positive")
    bars = _validate_dataset(dataset, spec["signalTimeframe"])
    grouped = _group_bars(bars)
    timestamps = sorted(grouped)
    starting_cash = cash
    lot_size = int(spec["positionSizing"]["lotSize"])
    stress_bps = (
        float(spec["execution"]["baseSlippageBps"])
        if slippage_bps is None
        else float(slippage_bps)
    )
    if not math.isfinite(stress_bps) or stress_bps < 0:
        raise ValueError("slippage_bps must be non-negative")

    positions = {}
    pending_entries = {}
    pending_exits = {}
    fills = []
    trades = []
    rejections = []
    equity_curve = []
    total_requested = 0
    total_capacity = 0
    partial_fills = 0
    gross_turnover = 0.0
    impact_cost = 0.0

    for timestamp in timestamps:
        rows = grouped[timestamp]

        for code in sorted(list(pending_exits)):
            order = pending_exits[code]
            position = positions.get(code)
            bar = rows.get(code)
            if not position or not bar:
                continue
            if bar["date"] <= position["entryDate"]:
                continue
            allowed, reason = _can_fill("SELL", bar)
            capacity = _capacity_quantity(spec, bar)
            total_capacity += capacity
            if not allowed or capacity < lot_size:
                rejections.append({
                    "timestamp": timestamp,
                    "code": code,
                    "side": "SELL",
                    "reason": reason or "CAPACITY",
                    "carried": True,
                })
                continue
            requested_before = order["remaining"]
            quantity = min(requested_before, capacity, position["quantity"])
            quantity = int(quantity // lot_size) * lot_size
            if quantity <= 0:
                continue
            fill = _effective_fill(
                bar["executionPrice"]["open"],
                "SELL",
                quantity,
                bar["volume"],
                spec,
                stress_bps,
            )
            gross = fill["price"] * quantity
            fees = trade_fees("sell", gross)
            cash += gross - fees["total"]
            position["quantity"] -= quantity
            order["remaining"] -= quantity
            partial = quantity < requested_before
            partial_fills += int(partial)
            gross_turnover += gross
            impact_cost += fill["impactCost"]
            fills.append({
                "timestamp": timestamp,
                "date": bar["date"],
                "code": code,
                "side": "SELL",
                "quantity": quantity,
                "referencePrice": _rounded(bar["executionPrice"]["open"]),
                "fillPrice": _rounded(fill["price"]),
                "participationRate": _rounded(fill["participationRate"]),
                "slippageBps": _rounded(fill["slippageBps"]),
                "fees": _rounded(fees["total"]),
                "impactCost": _rounded(fill["impactCost"]),
                "partial": partial,
                "reason": order["reason"],
            })
            if position["quantity"] <= 0:
                net_pnl = (
                    sum(
                        item["fillPrice"] * item["quantity"] - item["fees"]
                        for item in fills
                        if item["code"] == code
                        and item["side"] == "SELL"
                        and item["timestamp"] >= position["entryTimestamp"]
                    )
                    - position["entryCost"]
                )
                trades.append({
                    "code": code,
                    "entryTimestamp": position["entryTimestamp"],
                    "exitTimestamp": timestamp,
                    "holdingBars": position["holdingBars"],
                    "quantity": position["openedQuantity"],
                    "netPnl": _rounded(net_pnl),
                    "netReturn": _rounded(
                        net_pnl / position["entryCost"]
                        if position["entryCost"] > 0
                        else 0,
                    ),
                    "exitReason": order["reason"],
                })
                del positions[code]
                del pending_exits[code]
            elif order["remaining"] <= 0:
                del pending_exits[code]

        for code in sorted(list(pending_entries)):
            order = pending_entries[code]
            bar = rows.get(code)
            if not bar or code in pending_exits:
                continue
            allowed, reason = _can_fill("BUY", bar)
            capacity = _capacity_quantity(spec, bar)
            total_capacity += capacity
            if not allowed or capacity < lot_size:
                rejections.append({
                    "timestamp": timestamp,
                    "code": code,
                    "side": "BUY",
                    "reason": reason or "CAPACITY",
                    "carried": True,
                })
                continue
            requested_before = order["remaining"]
            quantity = min(requested_before, capacity)
            quantity = int(quantity // lot_size) * lot_size
            if quantity <= 0:
                continue
            fill = _effective_fill(
                bar["executionPrice"]["open"],
                "BUY",
                quantity,
                bar["volume"],
                spec,
                stress_bps,
            )
            gross = fill["price"] * quantity
            fees = trade_fees("buy", gross)
            while quantity >= lot_size and gross + fees["total"] > cash:
                quantity -= lot_size
                if quantity:
                    fill = _effective_fill(
                        bar["executionPrice"]["open"],
                        "BUY",
                        quantity,
                        bar["volume"],
                        spec,
                        stress_bps,
                    )
                    gross = fill["price"] * quantity
                    fees = trade_fees("buy", gross)
            if quantity < lot_size:
                rejections.append({
                    "timestamp": timestamp,
                    "code": code,
                    "side": "BUY",
                    "reason": "INSUFFICIENT_CASH",
                    "carried": True,
                })
                continue
            total_cost = gross + fees["total"]
            cash -= total_cost
            position = positions.get(code)
            if position:
                position["quantity"] += quantity
                position["openedQuantity"] += quantity
                position["entryCost"] += total_cost
                position["entryPrice"] = (
                    position["entryCost"] / position["openedQuantity"]
                )
            else:
                positions[code] = {
                    "code": code,
                    "industry": bar.get("industry") or "UNKNOWN",
                    "entryTimestamp": timestamp,
                    "entryDate": bar["date"],
                    "entryPrice": fill["price"],
                    "entryCost": total_cost,
                    "quantity": quantity,
                    "openedQuantity": quantity,
                    "holdingBars": 0,
                    "lastPrice": bar["executionPrice"]["open"],
                }
            order["remaining"] -= quantity
            partial = quantity < requested_before
            partial_fills += int(partial)
            gross_turnover += gross
            impact_cost += fill["impactCost"]
            fills.append({
                "timestamp": timestamp,
                "date": bar["date"],
                "code": code,
                "side": "BUY",
                "quantity": quantity,
                "referencePrice": _rounded(bar["executionPrice"]["open"]),
                "fillPrice": _rounded(fill["price"]),
                "participationRate": _rounded(fill["participationRate"]),
                "slippageBps": _rounded(fill["slippageBps"]),
                "fees": _rounded(fees["total"]),
                "impactCost": _rounded(fill["impactCost"]),
                "partial": partial,
                "signalTimestamp": order["signalTimestamp"],
            })
            if order["remaining"] <= 0:
                del pending_entries[code]

        for code, position in list(positions.items()):
            bar = rows.get(code)
            if not bar:
                continue
            close = _finite(bar["executionPrice"].get("close"))
            if close is None or close <= 0:
                continue
            position["lastPrice"] = close
            position["holdingBars"] += 1
            if code in pending_exits:
                continue
            entry_price = position["entryPrice"]
            exit_policy = spec["exit"]
            reason = None
            if close <= entry_price * (
                1.0 - float(exit_policy["stopLossPct"]) / 100.0
            ):
                reason = "STOP_LOSS"
            elif close >= entry_price * (
                1.0 + float(exit_policy["takeProfitPct"]) / 100.0
            ):
                reason = "TAKE_PROFIT"
            elif position["holdingBars"] >= int(exit_policy["maxHoldingBars"]):
                reason = "MAX_HOLD"
            elif exit_policy.get("signal") and _evaluate(
                exit_policy["signal"],
                _signal_context(bar),
            ):
                reason = "SIGNAL_EXIT"
            if reason:
                pending_entries.pop(code, None)
                pending_exits[code] = {
                    "remaining": position["quantity"],
                    "reason": reason,
                }

        market_value = 0.0
        industry_values = {}
        for code, position in positions.items():
            bar = rows.get(code)
            close = (
                _finite(bar["executionPrice"].get("close"))
                if bar
                else position["lastPrice"]
            )
            value = position["quantity"] * close
            market_value += value
            industry = position["industry"]
            industry_values[industry] = industry_values.get(industry, 0) + value
        equity = cash + market_value
        equity_curve.append({
            "timestamp": timestamp,
            "date": timestamp[:8],
            "cash": _rounded(cash),
            "marketValue": _rounded(market_value),
            "equity": _rounded(equity),
            "cashExposurePct": _rounded(cash / equity * 100 if equity else 0),
            "marketExposurePct": _rounded(
                market_value / equity * 100 if equity else 0
            ),
            "industryExposurePct": {
                industry: _rounded(value / equity * 100 if equity else 0)
                for industry, value in industry_values.items()
            },
        })

        if spec["riskLimits"]["allowRiskIncrease"]:
            candidates = []
            for code, bar in rows.items():
                if code in positions or code in pending_entries:
                    continue
                if bar.get("marketRegime") not in spec["eligibleRegimes"]:
                    continue
                if not _is_liquid(spec, bar):
                    continue
                if not _evaluate(spec["entry"], _signal_context(bar)):
                    continue
                candidates.append((_combined_score(spec, bar), code, bar))
            available_slots = max(
                0,
                int(spec["positionSizing"]["maxPositions"])
                - len(positions)
                - len(pending_entries),
            )
            for score, code, bar in sorted(
                candidates,
                key=lambda item: (-item[0], item[1]),
            )[:available_slots]:
                allocation_budget = (
                    equity
                    * float(spec["positionSizing"]["allocationPct"])
                    / 100.0
                )
                signal_price = float(bar["signalPrice"]["close"])
                stop_distance = (
                    signal_price
                    * float(spec["exit"]["stopLossPct"])
                    / 100.0
                )
                risk_budget = (
                    equity
                    * float(spec["positionSizing"]["riskPerTradePct"])
                    / 100.0
                )
                risk_quantity = (
                    risk_budget / stop_distance if stop_distance > 0 else 0
                )
                desired = min(
                    allocation_budget / signal_price,
                    risk_quantity,
                )
                quantity = int(desired // lot_size) * lot_size
                if quantity < lot_size:
                    continue
                pending_entries[code] = {
                    "remaining": quantity,
                    "requested": quantity,
                    "signalTimestamp": timestamp,
                    "score": score,
                }
                total_requested += quantity

    final_equity = equity_curve[-1]["equity"]
    maximum_drawdown = _maximum_drawdown(equity_curve)
    periods_per_year = (
        252 if spec["signalTimeframe"] == "1d" else 252 * 48
    )
    sharpe, sortino = _risk_ratios(equity_curve, periods_per_year)
    periods = max(1, len(equity_curve) - 1)
    annualized = (
        (final_equity / starting_cash) ** (periods_per_year / periods) - 1.0
        if final_equity > 0
        else -1.0
    )
    calmar = (
        annualized / abs(maximum_drawdown)
        if maximum_drawdown < 0
        else None
    )
    cash_exposures = [item["cashExposurePct"] for item in equity_curve]
    market_exposures = [item["marketExposurePct"] for item in equity_curve]
    industry_exposures = [
        value
        for item in equity_curve
        for value in item["industryExposurePct"].values()
    ]
    closed_pnl = [trade["netPnl"] for trade in trades]
    wins = [value for value in closed_pnl if value > 0]
    losses = [value for value in closed_pnl if value < 0]
    metrics = {
        "initialCash": _rounded(starting_cash),
        "finalEquity": _rounded(final_equity),
        "totalReturn": _rounded(final_equity / starting_cash - 1.0),
        "annualizedReturn": _rounded(annualized),
        "maximumDrawdown": _rounded(maximum_drawdown),
        "drawdownRecoveryBars": _drawdown_recovery_bars(equity_curve),
        "sharpe": sharpe,
        "sortino": sortino,
        "calmar": _rounded(calmar),
        "turnover": _rounded(
            gross_turnover
            / statistics.fmean(item["equity"] for item in equity_curve)
            if equity_curve
            else 0,
        ),
        "averageHoldingBars": _rounded(
            statistics.fmean(trade["holdingBars"] for trade in trades)
            if trades
            else 0,
        ),
        "closedTrades": len(trades),
        "winRate": _rounded(len(wins) / len(trades) if trades else 0),
        "profitFactor": (
            _rounded(sum(wins) / abs(sum(losses))) if losses else None
        ),
        "totalFees": _rounded(sum(fill["fees"] for fill in fills)),
        "estimatedImpactCost": _rounded(impact_cost),
        "partialFills": partial_fills,
        "queuedOrders": len(pending_entries) + len(pending_exits),
        "rejectedOrderEvents": len(rejections),
        "averageCashExposurePct": _rounded(
            statistics.fmean(cash_exposures) if cash_exposures else 100
        ),
        "averageMarketExposurePct": _rounded(
            statistics.fmean(market_exposures) if market_exposures else 0
        ),
        "maximumIndustryExposurePct": _rounded(
            max(industry_exposures) if industry_exposures else 0
        ),
        "requestedQuantity": total_requested,
        "filledQuantity": sum(
            fill["quantity"] for fill in fills if fill["side"] == "BUY"
        ),
        "capacityUtilizationPct": _rounded(
            min(
                100.0,
                (
                    sum(
                        fill["quantity"]
                        for fill in fills
                        if fill["side"] == "BUY"
                    )
                    / max(1, total_capacity)
                    * 100.0
                ),
            )
        ),
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "strategyId": spec["strategyId"],
        "specVersion": spec["specVersion"],
        "datasetHash": dataset["manifest"]["contentSha256"],
        "assumptions": {
            "signalPrice": "QFQ",
            "executionPrice": "RAW",
            "signalTimeframe": spec["signalTimeframe"],
            "executionTimeframe": spec["executionTimeframe"],
            "feePolicy": spec["execution"]["feePolicy"],
            "slippageBps": stress_bps,
            "spreadBps": spec["execution"]["spreadBps"],
            "maximumParticipationRate":
                spec["liquidityLimits"]["maximumParticipationRate"],
            "unfilledOrdersCarried": True,
        },
        "metrics": metrics,
        "fills": fills,
        "trades": trades,
        "rejections": rejections,
        "equityCurve": equity_curve,
        "openPositions": list(positions.values()),
        "pendingOrders": {
            "entries": list(pending_entries.values()),
            "exits": list(pending_exits.values()),
        },
        "benchmarks": benchmarks or {},
    }


def run_capacity_stress(strategy_spec, dataset):
    spec = validate_strategy_spec_v2(strategy_spec)
    scenarios = []
    for initial_cash in spec["capacityAssumptions"]["capitalScenarios"]:
        for slippage_bps in spec["capacityAssumptions"]["slippageScenariosBps"]:
            report = run_strategy_backtest_v2(
                spec,
                dataset,
                initial_cash=initial_cash,
                slippage_bps=slippage_bps,
            )
            metrics = report["metrics"]
            scenarios.append({
                "initialCash": initial_cash,
                "slippageBps": slippage_bps,
                "totalReturn": metrics["totalReturn"],
                "maximumDrawdown": metrics["maximumDrawdown"],
                "turnover": metrics["turnover"],
                "totalFees": metrics["totalFees"],
                "estimatedImpactCost": metrics["estimatedImpactCost"],
                "partialFills": metrics["partialFills"],
                "queuedOrders": metrics["queuedOrders"],
                "capacityUtilizationPct": metrics["capacityUtilizationPct"],
            })
    return {
        "schemaVersion": "strategy-capacity-stress.v1",
        "strategyId": spec["strategyId"],
        "specVersion": spec["specVersion"],
        "datasetHash": dataset["manifest"]["contentSha256"],
        "scenarios": scenarios,
    }


def _read_json(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(path, payload):
    output = os.path.abspath(path)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--strategy", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--stress", action="store_true")
    parser.add_argument("--initial-cash", type=float, default=1_000_000)
    parser.add_argument("--slippage-bps", type=float, default=None)
    args = parser.parse_args(argv)
    spec = load_strategy_spec_v2(args.strategy)
    dataset = _read_json(args.dataset)
    report = (
        run_capacity_stress(spec, dataset)
        if args.stress
        else run_strategy_backtest_v2(
            spec,
            dataset,
            initial_cash=args.initial_cash,
            slippage_bps=args.slippage_bps,
        )
    )
    _write_json(args.out, report)
    print(json.dumps({
        "schemaVersion": report["schemaVersion"],
        "strategyId": report["strategyId"],
        "specVersion": report["specVersion"],
    }, ensure_ascii=False, indent=2))
    print("STRATEGY_BACKTEST_V2_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
