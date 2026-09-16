"""Compare OOF selections on common complete minute dates under shared fee assumptions."""

import argparse
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

import numpy as np

from platform_app.modules.experiments.execution_walk_forward import requested_notional_return
from platform_app.modules.experiments.quant_model_trainer import _verified_database
from platform_app.modules.experiments.ranking_walk_forward import block_bootstrap_interval

SCENARIOS = ("ONE_BOARD_LOT", "REFERENCE_100K", "MEDIAN_AMOUNT_5_BPS",
             "MEDIAN_AMOUNT_20_BPS", "MEDIAN_AMOUNT_100_BPS")


def compare(selections, labels):
    models = sorted({name for r in selections for name in r["selectedBy"]})
    dates = sorted({r["decisionDate"] for r in selections})
    selected = defaultdict(list)
    for row in selections:
        for name in row["selectedBy"]:
            selected[(row["decisionDate"], name)].append(row["instrumentId"])
    results = {}
    for scenario in SCENARIOS:
        data = labels.get(scenario, {})
        complete_dates = [
            date for date in dates
            if all(len(selected[(date, name)]) == 10 and all(
                (date, stock) in data for stock in selected[(date, name)]
            ) for name in models)
        ]
        model_results, returns = {}, {}
        for name in models:
            coverage = sum((date, stock) in data for date in dates
                           for stock in selected[(date, name)])
            values = np.array([
                np.mean([data[(date, stock)]["netReturn"] for stock in selected[(date, name)]])
                for date in complete_dates
            ])
            returns[name] = values
            model_results[name] = {
                "coveredSelections": coverage, "totalSelections": len(dates) * 10,
                "completeCommonDates": len(complete_dates),
                "meanNetReturnOnRequestedNotional": float(values.mean()) if len(values) else None,
                "fillRatio": float(np.mean([
                    data[(date, stock)]["fillRatio"] for date in complete_dates
                    for stock in selected[(date, name)]
                ])) if complete_dates else None,
            }
        for name in models:
            model_results[name]["versusRank5"] = (
                block_bootstrap_interval(returns[name] - returns["rank5"])
                if len(complete_dates) >= 10 else None
            )
        marginal = {
            name: block_bootstrap_interval(returns["equal"] - returns[f"equal_without_{name}"])
            for name in ("rank5", "rank20", "rank100", "return")
            if len(complete_dates) >= 10 and f"equal_without_{name}" in returns
        }
        results[scenario] = {
            "models": model_results, "commonDates": complete_dates,
            "marginalContribution": marginal,
            "excludedDates": len(dates) - len(complete_dates),
        }
    return results


def run(experiment, label_root, output):
    manifest, path = _verified_database(label_root, "label-dataset.v2")
    selections = []
    for file in sorted(experiment.glob("fold-*/candidate-union.json")):
        selections.extend(json.loads(file.read_text())["candidates"])
    labels = defaultdict(dict)
    with sqlite3.connect(f"{path.as_uri()}?mode=ro&immutable=1", uri=True) as db:
        db.row_factory = sqlite3.Row
        for row in db.execute("SELECT * FROM episode_labels"):
            for scenario in json.loads(row["scenario_ids_json"]):
                labels[scenario][(row["decision_date"], row["instrument_id"])] = {
                    "netReturn": requested_notional_return(row), "fillRatio": float(row["fill_ratio"]),
                }
    report = {
        "schemaVersion": "combination-fee-comparison.v1", "labelManifest": manifest,
        "releaseStatus": "UNAVAILABLE",
        "assumptions": [
            "DEVELOPMENT_DATES_PREVIOUSLY_OBSERVED",
            "EPISODE_PNL_NOT_CONTINUOUS_ACCOUNT_RETURN",
            "COMMON_COMPLETE_DATES_ONLY_SELECTION_BIAS_REMAINS",
            "MINUTE_OHLC_NOT_ORDER_BOOK_QUEUE",
            "HISTORICAL_BOARD_RULES_AND_EXIT_LIQUIDITY_PENDING",
            "INDEPENDENT_AGENT_POSITION_CONFIRMATION_PENDING",
        ],
        "scenarios": compare(selections, labels),
    }
    output.write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("experiment", "label-root", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    run(args.experiment, args.label_root, args.output)
