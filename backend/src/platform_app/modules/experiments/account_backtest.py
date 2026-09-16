"""Capital-constrained replay for out-of-time quantitative selections."""

import hashlib
import json
import math
import os
import sqlite3
from collections import Counter
from datetime import UTC, datetime
from decimal import Decimal, ROUND_FLOOR
from pathlib import Path

from platform_app.modules.experiments.cash_equity_fees import (
    calculate_cash_equity_fees,
)
from platform_app.modules.experiments.execution_backtest import _verified_dataset
from platform_app.modules.experiments.quant_execution_backtest import (
    BACKTEST_SCHEMA_VERSION,
)
from platform_app.modules.experiments.quant_model_bundle import QuantModelBundle
from platform_app.modules.experiments.quant_model_trainer import QuantModelError
from platform_app.modules.experiments.quant_model_trainer import (
    _selected_ranking_features,
)
from platform_app.modules.experiments.short_horizon_labeler import (
    LABEL_SIMULATION_POLICY,
    label_order_scenario,
)

ACCOUNT_BACKTEST_SCHEMA_VERSION = "account-backtest.v1"
STRESS_COST = Decimal("0.001")
ACCOUNT_SIZES = (
    Decimal("100000"),
    Decimal("500000"),
    Decimal("1000000"),
    Decimal("5000000"),
)


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
    stressed_equity_curve = []
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
        stressed_equity_curve.append(stressed_cash + marked_value)

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
    stressed_equity_curve.append(stressed_cash)
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
        "stressMaximumDrawdown": _maximum_drawdown(stressed_equity_curve),
        "maxConcurrentPositions": max_concurrent,
        "counts": dict(sorted(counters.items())),
        "trades": trades,
    }


def _trade_breakdown(trades: list[dict], field: str) -> dict:
    values = sorted({trade[field] for trade in trades})
    result = {}
    for value in values:
        rows = [trade for trade in trades if trade[field] == value]
        result[value] = {
            "trades": len(rows),
            "netPnlCny": _text(
                sum((Decimal(row["netPnlCny"]) for row in rows), Decimal(0))
            ),
            "stressPnlCny": _text(
                sum((Decimal(row["stressPnlCny"]) for row in rows), Decimal(0))
            ),
        }
    return result


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _preferred_paths(database: sqlite3.Connection) -> list[sqlite3.Row]:
    return database.execute(
        "WITH preferred AS ("
        "SELECT l.*, ROW_NUMBER() OVER ("
        "PARTITION BY l.decision_date, l.instrument_id "
        "ORDER BY l.reference_100k DESC, "
        "ABS(CAST(l.target_notional_cny AS REAL) - 100000), l.target_shares"
        ") AS scenario_rank FROM episode_labels l"
        ") SELECT e.instrument_id, e.decision_date, e.execution_date, e.board, "
        "e.selection_score, l.median_amount20_cny, l.entry_price, l.exit_price, "
        "l.fill_capacity_shares, l.exit_reason, l.exit_date "
        "FROM episodes.candidate_episodes e LEFT JOIN preferred l "
        "ON l.decision_date=e.decision_date AND l.instrument_id=e.instrument_id "
        "AND l.scenario_rank=1 "
        "ORDER BY e.decision_date, CAST(e.selection_score AS REAL) DESC, e.instrument_id"
    ).fetchall()


def write_account_backtest(
    *,
    quant_backtest_path: Path,
    market_dataset_root: Path,
    ranking_dataset_root: Path,
    quant_model_root: Path,
    episode_dataset_root: Path,
    label_dataset_root: Path,
    output_path: Path,
) -> dict:
    quant_backtest_path = quant_backtest_path.resolve()
    quant_report = json.loads(quant_backtest_path.read_text())
    if quant_report.get("schemaVersion") != BACKTEST_SCHEMA_VERSION:
        raise QuantModelError("ACCOUNT_BACKTEST_INPUT_INVALID")
    market_manifest, market_path = _verified_dataset(
        market_dataset_root,
        "market-dataset.v4",
    )
    ranking_manifest, ranking_path = _verified_dataset(
        ranking_dataset_root,
        "ranking-dataset.v1",
    )
    episode_manifest, episode_path = _verified_dataset(
        episode_dataset_root,
        "episode-dataset.v4",
    )
    label_manifest, label_path = _verified_dataset(
        label_dataset_root,
        "label-dataset.v2",
    )
    bundle = QuantModelBundle(quant_model_root, require_ready=False)
    if (
        ranking_manifest["marketDatabaseSha256"]
        != market_manifest["databaseSha256"]
        or episode_manifest["marketDatabaseSha256"]
        != market_manifest["databaseSha256"]
        or label_manifest["episodeDatabaseSha256"]
        != episode_manifest["databaseSha256"]
        or bundle.manifest.get("rankingDatabaseSha256")
        != ranking_manifest["databaseSha256"]
        or quant_report["lineage"]["quantModelArtifactSha256"]
        != bundle.manifest["artifactSha256"]
        or quant_report["lineage"]["labelDatabaseSha256"]
        != label_manifest["databaseSha256"]
    ):
        raise QuantModelError("ACCOUNT_BACKTEST_LINEAGE_MISMATCH")

    database = sqlite3.connect(
        f"{label_path.resolve().as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    database.row_factory = sqlite3.Row
    database.execute(
        "ATTACH DATABASE ? AS episodes",
        (f"{episode_path.resolve().as_uri()}?mode=ro&immutable=1",),
    )
    database.execute(
        "ATTACH DATABASE ? AS ranking",
        (f"{ranking_path.resolve().as_uri()}?mode=ro&immutable=1",),
    )
    path_rows = _preferred_paths(database)
    ranking_features = _selected_ranking_features(
        database,
        expected_count=label_manifest["labels"]["episodes"],
    )
    candidates_by_date: dict[str, list[dict]] = {}
    rank_counters: dict[str, int] = Counter()
    for row in path_rows:
        decision_date = row["decision_date"]
        rank_counters[decision_date] += 1
        path = None
        base_features = None
        if row["median_amount20_cny"] is not None:
            base_features = ranking_features[
                (decision_date, row["instrument_id"])
            ]
            path = {
                "instrumentId": row["instrument_id"],
                "board": row["board"],
                "decisionDate": decision_date,
                "entryDate": row["execution_date"],
                "entryPrice": row["entry_price"],
                "fillCapacityShares": row["fill_capacity_shares"],
                "exitPrice": row["exit_price"],
                "exitReason": row["exit_reason"],
                "exitDate": row["exit_date"],
            }
        candidates_by_date.setdefault(decision_date, []).append(
            {
                "instrumentId": row["instrument_id"],
                "board": row["board"],
                "rankPosition": rank_counters[decision_date],
                "medianAmount20Cny": row["median_amount20_cny"],
                "baseFeatures": base_features,
                "path": path,
            }
        )
    database.close()
    if sum(map(len, candidates_by_date.values())) != episode_manifest["coverage"][
        "episodes"
    ]["total"]:
        raise QuantModelError("ACCOUNT_BACKTEST_CANDIDATE_COUNT_MISMATCH")

    instrument_ids = sorted(
        {
            candidate["instrumentId"]
            for candidates in candidates_by_date.values()
            for candidate in candidates
        }
    )
    placeholders = ",".join("?" for _ in instrument_ids)
    start_date = min(candidates_by_date)
    end_date = max(
        candidate["path"]["exitDate"]
        for candidates in candidates_by_date.values()
        for candidate in candidates
        if candidate["path"] and candidate["path"]["exitDate"]
    )
    market = sqlite3.connect(
        f"{market_path.resolve().as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    market.row_factory = sqlite3.Row
    close_prices = {
        (row["trade_date"], row["instrument_id"]): Decimal(row["close"])
        for row in market.execute(
            "SELECT trade_date,instrument_id,close FROM daily_bars "
            f"WHERE trade_date BETWEEN ? AND ? AND instrument_id IN ({placeholders})",
            (start_date, end_date, *instrument_ids),
        )
    }
    market.close()

    scenarios = []
    for initial_cash in ACCOUNT_SIZES:
        result = replay_account(
            candidates_by_date=candidates_by_date,
            close_prices=close_prices,
            bundle=bundle,
            initial_cash=initial_cash,
        )
        result["tradesByBoard"] = _trade_breakdown(result["trades"], "board")
        for trade in result["trades"]:
            trade["exitYear"] = trade["exitDate"][:4]
        result["tradesByExitYear"] = _trade_breakdown(
            result["trades"],
            "exitYear",
        )
        scenarios.append(result)

    blockers = [
        value
        for value in quant_report["releaseBlockers"]
        if value != "ACCOUNT_CAPITAL_REPLAY_PENDING"
    ]
    if any(result["stressNetReturn"] <= 0 for result in scenarios):
        blockers.insert(0, "ACCOUNT_SCENARIO_STRESS_RETURN_NOT_POSITIVE")
    report = {
        "schemaVersion": ACCOUNT_BACKTEST_SCHEMA_VERSION,
        "createdAt": datetime.now(UTC).isoformat(),
        "releaseStatus": "UNAVAILABLE",
        "releaseBlockers": blockers,
        "policy": {
            "initialCashScenariosCny": [_text(value) for value in ACCOUNT_SIZES],
            "maxConcurrentPositions": 10,
            "targetNotional": "INITIAL_CASH_DIVIDED_BY_MAX_POSITIONS",
            "minimumTarget": "ONE_BOARD_LOT_IF_CASH_ALLOWS",
            "sameInstrumentOverlap": "SKIP",
            "sameDayCashReuse": "BUYS_BEFORE_EXITS",
            "markToMarket": "CANONICAL_DAILY_CLOSE_LAST_PRICE_IF_SUSPENDED",
            "modelGate": "pFill*(expectedNetReturnGivenFill-0.001)>0",
            "stressCostBps": 10,
        },
        "lineage": {
            **quant_report["lineage"],
            "quantExecutionBacktestSha256": _file_sha256(quant_backtest_path),
            "marketDatasetId": market_manifest["datasetId"],
            "marketDatabaseSha256": market_manifest["databaseSha256"],
            "episodeDatasetId": episode_manifest["datasetId"],
            "episodeDatabaseSha256": episode_manifest["databaseSha256"],
            "labelDatasetId": label_manifest["datasetId"],
            "labelDatabaseSha256": label_manifest["databaseSha256"],
        },
        "coverage": quant_report["coverage"],
        "accountScenarios": scenarios,
    }
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    os.replace(temporary, output_path)
    return report
