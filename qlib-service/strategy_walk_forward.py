"""Purged expanding-window evaluation for a frozen strategy-spec.v1."""

import argparse
import gzip
import json
import math
import os

from strategy_contract import load_strategy_spec, validate_strategy_spec
from strategy_portfolio_backtest import run_portfolio_backtest


def build_walk_forward_windows(
    dates,
    *,
    minimum_train_days,
    purge_days,
    test_days,
    step_days,
):
    unique_dates = sorted(set(str(date).replace("-", "") for date in dates))
    if minimum_train_days <= 0:
        raise ValueError("minimum_train_days must be positive")
    if purge_days < 0:
        raise ValueError("purge_days must be non-negative")
    if test_days <= 0:
        raise ValueError("test_days must be positive")
    if step_days < test_days:
        raise ValueError(
            "step_days must be at least test_days to avoid overlapping tests"
        )
    windows = []
    train_end_index = int(minimum_train_days) - 1
    while True:
        test_start_index = train_end_index + int(purge_days) + 1
        test_end_index = test_start_index + int(test_days)
        if test_end_index > len(unique_dates):
            break
        purge_slice = unique_dates[
            train_end_index + 1:test_start_index
        ]
        test_slice = unique_dates[test_start_index:test_end_index]
        windows.append({
            "fold": len(windows) + 1,
            "trainStart": unique_dates[0],
            "trainEnd": unique_dates[train_end_index],
            "trainDays": train_end_index + 1,
            "purgeDates": purge_slice,
            "testStart": test_slice[0],
            "testEnd": test_slice[-1],
            "testDates": test_slice,
            "testDays": len(test_slice),
        })
        train_end_index += int(step_days)
    if not windows:
        raise ValueError("not enough dates for one walk-forward fold")
    return windows


def _rounded(value):
    return round(float(value), 6)


def run_walk_forward(
    strategy_spec,
    dataset,
    *,
    minimum_train_days,
    purge_days,
    test_days,
    step_days,
    initial_cash=1_000_000,
):
    spec = validate_strategy_spec(strategy_spec)
    if not isinstance(dataset, dict):
        raise ValueError("dataset must be an object")
    if dataset.get("schemaVersion") != "strategy-dataset.v1":
        raise ValueError("unsupported strategy dataset schema")
    if (dataset.get("quality") or {}).get("usable") is not True:
        raise ValueError("strategy dataset failed quality gate")
    bars = dataset.get("bars")
    if not isinstance(bars, list) or not bars:
        raise ValueError("strategy dataset contains no bars")
    dates = sorted(set(str(item["date"]) for item in bars))
    windows = build_walk_forward_windows(
        dates,
        minimum_train_days=minimum_train_days,
        purge_days=purge_days,
        test_days=test_days,
        step_days=step_days,
    )

    folds = []
    fold_returns = []
    all_trades = 0
    all_rejections = 0
    all_fees = 0.0
    tested_dates = set()
    for window in windows:
        allowed = set(window["testDates"])
        test_bars = [item for item in bars if str(item["date"]) in allowed]
        if not test_bars:
            raise ValueError(
                "walk-forward fold %d has no test bars" % window["fold"]
            )
        backtest = run_portfolio_backtest(
            spec,
            test_bars,
            initial_cash=initial_cash,
        )
        metrics = backtest["metrics"]
        fold_returns.append(float(metrics["totalReturn"]))
        all_trades += int(metrics["closedTrades"])
        all_rejections += int(metrics["rejectedOrders"])
        all_fees += float(metrics["totalFees"])
        tested_dates.update(allowed)
        folds.append({
            "window": {
                key: value
                for key, value in window.items()
                if key != "testDates"
            },
            "metrics": metrics,
            "tradeCount": len(backtest["trades"]),
            "rejections": backtest["rejections"],
            "trades": backtest["trades"],
            "openPositions": backtest["openPositions"],
        })

    compounded = math.prod(1.0 + value for value in fold_returns) - 1.0
    positive = sum(value > 0 for value in fold_returns)
    return {
        "schemaVersion": "strategy-walk-forward.v1",
        "strategyId": spec["strategyId"],
        "specVersion": spec["specVersion"],
        "datasetSchemaVersion": dataset["schemaVersion"],
        "methodology": {
            "kind": "PURGED_EXPANDING_WINDOW_FROZEN_STRATEGY",
            "minimumTrainDays": int(minimum_train_days),
            "purgeDays": int(purge_days),
            "testDays": int(test_days),
            "stepDays": int(step_days),
            "foldCapitalReset": True,
            "parameterTuning": False,
            "testWindowsOverlap": False,
        },
        "foldCount": len(folds),
        "folds": folds,
        "summary": {
            "testedDates": len(tested_dates),
            "closedTrades": all_trades,
            "rejectedOrders": all_rejections,
            "totalFees": _rounded(all_fees),
            "positiveFolds": positive,
            "positiveFoldRate": _rounded(positive / len(folds)),
            "meanFoldReturn": _rounded(
                sum(fold_returns) / len(fold_returns)
            ),
            "compoundedFoldReturn": _rounded(compounded),
            "worstFoldReturn": _rounded(min(fold_returns)),
            "bestFoldReturn": _rounded(max(fold_returns)),
        },
    }


def _read_json(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(path, payload):
    output = os.path.abspath(path)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    temporary = "%s.tmp.%d" % (output, os.getpid())
    opener = gzip.open if output.endswith(".gz") else open
    try:
        with opener(temporary, "wt", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--strategy", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--minimum-train-days", type=int, default=60)
    parser.add_argument("--purge-days", type=int, default=5)
    parser.add_argument("--test-days", type=int, default=20)
    parser.add_argument("--step-days", type=int, default=20)
    parser.add_argument("--initial-cash", type=float, default=1_000_000)
    args = parser.parse_args(argv)
    report = run_walk_forward(
        load_strategy_spec(args.strategy),
        _read_json(args.dataset),
        minimum_train_days=args.minimum_train_days,
        purge_days=args.purge_days,
        test_days=args.test_days,
        step_days=args.step_days,
        initial_cash=args.initial_cash,
    )
    _write_json(args.out, report)
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    print("STRATEGY_WALK_FORWARD_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
