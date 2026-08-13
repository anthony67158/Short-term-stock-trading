"""Portfolio-level A-share backtest driven by strategy-spec.v1."""

import argparse
import json
import math
import os
import re

from ashare_execution import (
    can_fill_open,
    execution_price,
    limit_prices,
    price_limit_pct,
    trade_fees,
)
from strategy_contract import load_strategy_spec, validate_strategy_spec


def _finite(value, default=None):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _field_value(context, field):
    value = context
    for key in field.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


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
        number = _finite(actual)
        return (
            number is not None
            and float(expected[0]) <= number <= float(expected[1])
        )
    number = _finite(actual)
    threshold = _finite(expected)
    if number is None or threshold is None:
        return False
    if operator == "GT":
        return number > threshold
    if operator == "GTE":
        return number >= threshold
    if operator == "LT":
        return number < threshold
    if operator == "LTE":
        return number <= threshold
    return False


def _evaluate_node(node, context):
    if node.get("type"):
        children = [_evaluate_node(item, context) for item in node["conditions"]]
        if node["type"] == "ALL":
            return all(children)
        return any(children)
    return _rule_passed(
        _field_value(context, node["field"]),
        node["op"],
        node.get("value"),
    )


def _combined_score(spec, bar):
    quant = bar.get("quant") or {}
    weights = spec["score"]["weights"]
    normalization = spec["score"]["normalization"]
    minimum = float(normalization["expectedReturnMin"])
    maximum = float(normalization["expectedReturnMax"])
    expected_score = max(
        0.0,
        min(
            100.0,
            (_finite(quant.get("expRet"), 0.0) - minimum)
            / (maximum - minimum)
            * 100.0,
        ),
    )
    score = (
        max(0.0, min(100.0, _finite(bar.get("marketScore"), 0.0)))
        * float(weights["marketScore"])
        + max(0.0, min(100.0, _finite(quant.get("score"), 45.0)))
        * float(weights["quantScore"])
        + max(0.0, min(100.0, _finite(quant.get("upProb"), 50.0)))
        * float(weights["upProb"])
        + expected_score
        * float(weights["expectedReturn"])
    )
    if quant.get("highConfFired") is True:
        score += float(spec["score"]["bonuses"]["highConfidence"])
    return max(0.0, min(100.0, score))


def _normalise_bars(bars):
    if not isinstance(bars, list) or not bars:
        raise ValueError("bars must be a non-empty list")
    grouped = {}
    seen = set()
    for source in bars:
        if not isinstance(source, dict):
            raise ValueError("every bar must be an object")
        item = dict(source)
        date = str(item.get("date", "")).replace("-", "")
        code = str(item.get("code", "")).upper()
        if not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", code):
            raise ValueError("bar code must use 000001.SZ format")
        if not re.fullmatch(r"\d{8}", date):
            raise ValueError("bar date must use YYYYMMDD format")
        key = (date, code)
        if key in seen:
            raise ValueError("duplicate bar for %s on %s" % (code, date))
        seen.add(key)
        item["date"] = date
        item["code"] = code
        for field in (
            "open",
            "high",
            "low",
            "close",
            "previousClose",
            "volume",
        ):
            item[field] = _finite(item.get(field))
        grouped.setdefault(date, {})[code] = item
    return grouped


def _is_st(bar):
    return bool(bar.get("isSt")) or bool(
        re.search(r"(?:\*?ST)", str(bar.get("name", "")), re.IGNORECASE)
    )


def _fill_rejection(side, bar):
    if (
        not bar
        or not bar.get("open")
        or not bar.get("volume")
        or bar["volume"] <= 0
    ):
        return "SUSPENDED_OR_NO_LIQUIDITY"
    previous_close = bar.get("previousClose")
    if not previous_close or previous_close <= 0:
        return "INVALID_MARKET_DATA"
    limit_pct = price_limit_pct(
        bar["code"],
        bar["date"],
        is_st=_is_st(bar),
    )
    lower, upper = limit_prices(previous_close, limit_pct)
    if side == "buy" and bar["open"] >= upper:
        return "LIMIT_UP"
    if side == "sell" and bar["open"] <= lower:
        return "LIMIT_DOWN"
    return "UNFILLED"


def _maximum_drawdown(equity_curve):
    peak = None
    worst = 0.0
    for item in equity_curve:
        equity = float(item["equity"])
        peak = equity if peak is None else max(peak, equity)
        if peak > 0:
            worst = min(worst, equity / peak - 1.0)
    return worst


def _rounded(value):
    return round(float(value), 6)


def _position_value(position, bar=None, field="close"):
    price = None
    if bar:
        price = _finite(bar.get(field))
    if price is None or price <= 0:
        price = position["lastPrice"]
    return position["quantity"] * price


def run_portfolio_backtest(strategy_spec, bars, *, initial_cash=1_000_000):
    spec = validate_strategy_spec(strategy_spec)
    starting_cash = _finite(initial_cash)
    if starting_cash is None or starting_cash <= 0:
        raise ValueError("initial_cash must be positive and finite")
    grouped = _normalise_bars(bars)
    dates = sorted(grouped)
    execution = spec["execution"]
    position_policy = spec["position"]
    exit_policy = spec["exit"]
    slippage_bps = float(execution["slippageBps"])
    lot_size = int(position_policy["lotSize"])
    maximum_positions = int(position_policy["maxPositions"])
    allocation = float(position_policy["allocationPct"]) / 100.0

    cash = float(starting_cash)
    positions = {}
    pending_entries = []
    trades = []
    rejections = []
    equity_curve = []
    opened_trades = 0

    for date in dates:
        rows = grouped[date]

        # Orders scheduled at a previous close execute at this open.
        for code in sorted(list(positions)):
            position = positions[code]
            if not position.get("pendingExit"):
                continue
            bar = rows.get(code)
            if not bar:
                rejections.append({
                    "date": date,
                    "code": code,
                    "side": "SELL",
                    "reason": "MISSING_BAR",
                })
                continue
            limit_pct = price_limit_pct(
                code,
                date,
                is_st=_is_st(bar),
            )
            if not can_fill_open(
                side="sell",
                previous_close=bar["previousClose"],
                open_price=bar["open"],
                volume=bar["volume"],
                limit_pct=limit_pct,
            ):
                rejections.append({
                    "date": date,
                    "code": code,
                    "side": "SELL",
                    "reason": _fill_rejection("sell", bar),
                })
                continue
            exit_price = execution_price(
                bar["open"],
                "sell",
                slippage_bps,
            )
            exit_gross = exit_price * position["quantity"]
            exit_fees = trade_fees("sell", exit_gross)
            cash += exit_gross - exit_fees["total"]
            net_pnl = (
                exit_gross
                - exit_fees["total"]
                - position["entryGross"]
                - position["entryFees"]
            )
            trades.append({
                "code": code,
                "signalDate": position["signalDate"],
                "entryDate": position["entryDate"],
                "exitDate": date,
                "quantity": position["quantity"],
                "entryPrice": _rounded(position["entryPrice"]),
                "exitPrice": _rounded(exit_price),
                "entryFees": _rounded(position["entryFees"]),
                "exitFees": _rounded(exit_fees["total"]),
                "totalFees": _rounded(
                    position["entryFees"] + exit_fees["total"]
                ),
                "netPnl": _rounded(net_pnl),
                "netReturn": _rounded(
                    net_pnl
                    / (position["entryGross"] + position["entryFees"])
                ),
                "holdingDays": position["holdingDays"],
                "exitReason": position["pendingExit"],
                "signalScore": _rounded(position["signalScore"]),
            })
            del positions[code]

        for signal in pending_entries:
            code = signal["code"]
            if code in positions:
                rejections.append({
                    "date": date,
                    "code": code,
                    "side": "BUY",
                    "reason": "ALREADY_HELD",
                    "signalDate": signal["signalDate"],
                })
                continue
            if len(positions) >= maximum_positions:
                rejections.append({
                    "date": date,
                    "code": code,
                    "side": "BUY",
                    "reason": "MAX_POSITIONS",
                    "signalDate": signal["signalDate"],
                })
                continue
            bar = rows.get(code)
            if not bar:
                rejections.append({
                    "date": date,
                    "code": code,
                    "side": "BUY",
                    "reason": "MISSING_BAR",
                    "signalDate": signal["signalDate"],
                })
                continue
            limit_pct = price_limit_pct(
                code,
                date,
                is_st=_is_st(bar),
            )
            if not can_fill_open(
                side="buy",
                previous_close=bar["previousClose"],
                open_price=bar["open"],
                volume=bar["volume"],
                limit_pct=limit_pct,
            ):
                rejections.append({
                    "date": date,
                    "code": code,
                    "side": "BUY",
                    "reason": _fill_rejection("buy", bar),
                    "signalDate": signal["signalDate"],
                })
                continue

            open_equity = cash + sum(
                _position_value(
                    position,
                    rows.get(held_code),
                    field="open",
                )
                for held_code, position in positions.items()
            )
            budget = open_equity * allocation
            fill_price = execution_price(
                bar["open"],
                "buy",
                slippage_bps,
            )
            quantity = int(budget // (fill_price * lot_size)) * lot_size
            entry_fees = None
            entry_gross = None
            while quantity >= lot_size:
                entry_gross = fill_price * quantity
                entry_fees = trade_fees("buy", entry_gross)
                total_cost = entry_gross + entry_fees["total"]
                if total_cost <= cash and total_cost <= budget:
                    break
                quantity -= lot_size
            if quantity < lot_size:
                rejections.append({
                    "date": date,
                    "code": code,
                    "side": "BUY",
                    "reason": "INSUFFICIENT_CASH",
                    "signalDate": signal["signalDate"],
                })
                continue
            total_cost = entry_gross + entry_fees["total"]
            cash -= total_cost
            positions[code] = {
                "code": code,
                "signalDate": signal["signalDate"],
                "entryDate": date,
                "entryPrice": fill_price,
                "entryGross": entry_gross,
                "entryFees": entry_fees["total"],
                "quantity": quantity,
                "holdingDays": 0,
                "lastPrice": bar["open"],
                "pendingExit": None,
                "signalScore": signal["score"],
            }
            opened_trades += 1
        pending_entries = []

        for code, position in positions.items():
            bar = rows.get(code)
            close = _finite(bar.get("close")) if bar else None
            if close is None or close <= 0:
                continue
            position["lastPrice"] = close
            position["holdingDays"] += 1
            if position.get("pendingExit"):
                continue
            if close <= (
                position["entryPrice"]
                * (1.0 - float(exit_policy["stopLossPct"]) / 100.0)
            ):
                position["pendingExit"] = "STOP_LOSS"
            elif close >= (
                position["entryPrice"]
                * (1.0 + float(exit_policy["takeProfitPct"]) / 100.0)
            ):
                position["pendingExit"] = "TAKE_PROFIT"
            elif position["holdingDays"] >= int(exit_policy["maxHoldingDays"]):
                position["pendingExit"] = "MAX_HOLD"

        market_value = sum(
            _position_value(position, rows.get(code))
            for code, position in positions.items()
        )
        equity_curve.append({
            "date": date,
            "cash": _rounded(cash),
            "marketValue": _rounded(market_value),
            "equity": _rounded(cash + market_value),
            "positionCount": len(positions),
        })

        signals = []
        for code in sorted(rows):
            if code in positions:
                continue
            bar = rows[code]
            if not _evaluate_node(spec["entry"], bar):
                continue
            signals.append({
                "code": code,
                "signalDate": date,
                "score": _combined_score(spec, bar),
            })
        pending_entries = sorted(
            signals,
            key=lambda item: (-item["score"], item["code"]),
        )

    final_equity = equity_curve[-1]["equity"]
    wins = [trade["netPnl"] for trade in trades if trade["netPnl"] > 0]
    losses = [trade["netPnl"] for trade in trades if trade["netPnl"] < 0]
    total_fees = sum(trade["totalFees"] for trade in trades) + sum(
        position["entryFees"] for position in positions.values()
    )
    open_positions = []
    for code in sorted(positions):
        position = positions[code]
        unrealized = (
            position["lastPrice"] * position["quantity"]
            - position["entryGross"]
            - position["entryFees"]
        )
        open_positions.append({
            "code": code,
            "signalDate": position["signalDate"],
            "entryDate": position["entryDate"],
            "quantity": position["quantity"],
            "entryPrice": _rounded(position["entryPrice"]),
            "lastPrice": _rounded(position["lastPrice"]),
            "holdingDays": position["holdingDays"],
            "pendingExit": position["pendingExit"],
            "unrealizedPnlBeforeExitFees": _rounded(unrealized),
        })

    return {
        "schemaVersion": "strategy-backtest.v1",
        "strategyId": spec["strategyId"],
        "specVersion": spec["specVersion"],
        "assumptions": {
            "signalAt": "CLOSE",
            "entryAt": execution["entryAt"],
            "exitAt": execution["exitAt"],
            "exitTrigger": "CLOSE",
            "tPlusOne": True,
            "slippageBps": slippage_bps,
            "feePolicy": execution["feePolicy"],
        },
        "metrics": {
            "initialCash": _rounded(starting_cash),
            "finalEquity": _rounded(final_equity),
            "totalReturn": _rounded(final_equity / starting_cash - 1.0),
            "maximumDrawdown": _rounded(
                _maximum_drawdown(equity_curve)
            ),
            "openedTrades": opened_trades,
            "closedTrades": len(trades),
            "winRate": _rounded(
                len(wins) / len(trades) if trades else 0.0
            ),
            "profitFactor": (
                _rounded(sum(wins) / abs(sum(losses)))
                if losses
                else None
            ),
            "expectancy": _rounded(
                sum(trade["netPnl"] for trade in trades) / len(trades)
                if trades
                else 0.0
            ),
            "totalFees": _rounded(total_fees),
            "rejectedOrders": len(rejections),
            "openPositions": len(positions),
            "pendingSignals": len(pending_entries),
        },
        "trades": trades,
        "rejections": rejections,
        "equityCurve": equity_curve,
        "openPositions": open_positions,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Run a strategy-spec.v1 A-share portfolio backtest",
    )
    parser.add_argument(
        "--strategy",
        required=True,
        help="strategy JSON file or /api/strategy_specs URL",
    )
    parser.add_argument("--bars", required=True, help="point-in-time bars JSON")
    parser.add_argument("--out", required=True, help="report JSON path")
    parser.add_argument(
        "--initial-cash",
        type=float,
        default=1_000_000,
    )
    args = parser.parse_args(argv)

    strategy = load_strategy_spec(args.strategy)
    with open(args.bars, "r", encoding="utf-8") as handle:
        bars_payload = json.load(handle)
    bars = (
        bars_payload.get("bars")
        if isinstance(bars_payload, dict)
        else bars_payload
    )
    report = run_portfolio_backtest(
        strategy,
        bars,
        initial_cash=args.initial_cash,
    )

    output_path = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    temporary_path = "%s.tmp.%d" % (output_path, os.getpid())
    try:
        with open(temporary_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary_path, output_path)
    finally:
        if os.path.exists(temporary_path):
            os.remove(temporary_path)
    print(json.dumps(report["metrics"], ensure_ascii=False, indent=2))
    print("STRATEGY_PORTFOLIO_BACKTEST_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
