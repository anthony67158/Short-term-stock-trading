"""Nested purged walk-forward with strict benchmark excess returns."""

import argparse
import gzip
import json
import math
import os
import re

from strategy_contract import validate_strategy_spec
from strategy_portfolio_backtest import run_portfolio_backtest
from strategy_walk_forward import build_walk_forward_windows


def _rounded(value):
    return round(float(value), 6)


def benchmark_window_return(series, test_dates):
    if not isinstance(series, dict):
        raise ValueError("benchmark series must be a date-to-close object")
    dates = [str(date).replace("-", "") for date in test_dates]
    if not dates:
        raise ValueError("benchmark test dates must be non-empty")
    closes = []
    for date in dates:
        if date not in series:
            raise ValueError("missing benchmark date: %s" % date)
        try:
            close = float(series[date])
        except (TypeError, ValueError):
            raise ValueError("invalid benchmark close on %s" % date)
        if not math.isfinite(close) or close <= 0:
            raise ValueError("invalid benchmark close on %s" % date)
        closes.append(close)
    return {
        "startDate": dates[0],
        "endDate": dates[-1],
        "startClose": _rounded(closes[0]),
        "endClose": _rounded(closes[-1]),
        "totalReturn": _rounded(closes[-1] / closes[0] - 1.0),
        "coveredDates": len(dates),
    }


def _validate_candidates(candidates):
    if not isinstance(candidates, list) or len(candidates) < 2:
        raise ValueError("at least two pre-registered candidates are required")
    output = []
    seen_ids = set()
    seen_versions = set()
    for item in candidates:
        if not isinstance(item, dict):
            raise ValueError("candidate must be an object")
        candidate_id = str(item.get("candidateId", ""))
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,63}", candidate_id):
            raise ValueError("invalid candidateId")
        if candidate_id in seen_ids:
            raise ValueError("duplicate candidateId: %s" % candidate_id)
        hypothesis = str(item.get("hypothesis", "")).strip()
        if not hypothesis:
            raise ValueError("candidate hypothesis is required")
        spec = validate_strategy_spec(item.get("strategy"))
        if spec["specVersion"] in seen_versions:
            raise ValueError("candidate strategies must be distinct")
        seen_ids.add(candidate_id)
        seen_versions.add(spec["specVersion"])
        output.append({
            "candidateId": candidate_id,
            "hypothesis": hypothesis,
            "strategy": spec,
        })
    return output


def _validate_dataset(dataset):
    if not isinstance(dataset, dict):
        raise ValueError("dataset must be an object")
    if dataset.get("schemaVersion") != "strategy-dataset.v1":
        raise ValueError("unsupported strategy dataset schema")
    if (dataset.get("quality") or {}).get("usable") is not True:
        raise ValueError("strategy dataset failed quality gate")
    bars = dataset.get("bars")
    if not isinstance(bars, list) or not bars:
        raise ValueError("strategy dataset contains no bars")
    return bars


def _candidate_inner_score(
    candidate,
    train_bars,
    *,
    minimum_train_days,
    purge_days,
    test_days,
    step_days,
    initial_cash,
):
    train_dates = sorted({str(item["date"]) for item in train_bars})
    windows = build_walk_forward_windows(
        train_dates,
        minimum_train_days=minimum_train_days,
        purge_days=purge_days,
        test_days=test_days,
        step_days=step_days,
    )
    returns = []
    validations = []
    for window in windows:
        allowed = set(window["testDates"])
        validation_bars = [
            item for item in train_bars
            if str(item["date"]) in allowed
        ]
        backtest = run_portfolio_backtest(
            candidate["strategy"],
            validation_bars,
            initial_cash=initial_cash,
        )
        total_return = float(backtest["metrics"]["totalReturn"])
        returns.append(total_return)
        validations.append({
            "trainEnd": window["trainEnd"],
            "purgeDates": window["purgeDates"],
            "validationStart": window["testStart"],
            "validationEnd": window["testEnd"],
            "totalReturn": _rounded(total_return),
            "maximumDrawdown": _rounded(
                backtest["metrics"]["maximumDrawdown"]
            ),
            "closedTrades": int(backtest["metrics"]["closedTrades"]),
        })
    compounded = math.prod(1.0 + value for value in returns) - 1.0
    positive = sum(value > 0 for value in returns)
    return {
        "candidateId": candidate["candidateId"],
        "specVersion": candidate["strategy"]["specVersion"],
        "innerFoldCount": len(returns),
        "positiveFoldRate": _rounded(positive / len(returns)),
        "compoundedReturn": _rounded(compounded),
        "worstFoldReturn": _rounded(min(returns)),
        "meanFoldReturn": _rounded(sum(returns) / len(returns)),
        "validations": validations,
    }


def _selection_key(score):
    return (
        -float(score["positiveFoldRate"]),
        -float(score["compoundedReturn"]),
        -float(score["worstFoldReturn"]),
        score["candidateId"],
    )


def _select_candidate(candidates, train_bars, **inner_options):
    scores = [
        _candidate_inner_score(candidate, train_bars, **inner_options)
        for candidate in candidates
    ]
    ranked = sorted(scores, key=_selection_key)
    selected = ranked[0]
    candidate = next(
        item for item in candidates
        if item["candidateId"] == selected["candidateId"]
    )
    latest_validation = max(
        item["validationEnd"]
        for score in scores
        for item in score["validations"]
    )
    return candidate, {
        "objective": (
            "POSITIVE_FOLD_RATE_THEN_COMPOUNDED_RETURN_"
            "THEN_WORST_FOLD_THEN_ID"
        ),
        "latestValidationDate": latest_validation,
        "candidateScores": ranked,
    }


def run_nested_walk_forward(
    candidates,
    dataset,
    benchmarks,
    *,
    outer_minimum_train_days,
    outer_purge_days,
    outer_test_days,
    outer_step_days,
    inner_minimum_train_days,
    inner_purge_days,
    inner_test_days,
    inner_step_days,
    initial_cash=1_000_000,
):
    validated_candidates = _validate_candidates(candidates)
    bars = _validate_dataset(dataset)
    if not isinstance(benchmarks, dict) or not benchmarks:
        raise ValueError("at least one benchmark is required")
    benchmark_series = {
        str(name): series for name, series in benchmarks.items()
    }
    dates = sorted({str(item["date"]) for item in bars})
    outer_windows = build_walk_forward_windows(
        dates,
        minimum_train_days=outer_minimum_train_days,
        purge_days=outer_purge_days,
        test_days=outer_test_days,
        step_days=outer_step_days,
    )

    folds = []
    strategy_returns = []
    benchmark_returns = {name: [] for name in benchmark_series}
    selection_counts = {}
    for window in outer_windows:
        train_allowed = {
            date for date in dates
            if window["trainStart"] <= date <= window["trainEnd"]
        }
        test_allowed = set(window["testDates"])
        train_bars = [
            item for item in bars
            if str(item["date"]) in train_allowed
        ]
        test_bars = [
            item for item in bars
            if str(item["date"]) in test_allowed
        ]
        selected, selection = _select_candidate(
            validated_candidates,
            train_bars,
            minimum_train_days=inner_minimum_train_days,
            purge_days=inner_purge_days,
            test_days=inner_test_days,
            step_days=inner_step_days,
            initial_cash=initial_cash,
        )
        if selection["latestValidationDate"] >= window["testStart"]:
            raise ValueError("inner validation leaked into outer test")
        backtest = run_portfolio_backtest(
            selected["strategy"],
            test_bars,
            initial_cash=initial_cash,
        )
        strategy_return = float(backtest["metrics"]["totalReturn"])
        strategy_returns.append(strategy_return)
        selection_counts[selected["candidateId"]] = (
            selection_counts.get(selected["candidateId"], 0) + 1
        )
        fold_benchmarks = {}
        fold_excess = {}
        for name, series in benchmark_series.items():
            benchmark = benchmark_window_return(
                series,
                window["testDates"],
            )
            benchmark_return = float(benchmark["totalReturn"])
            benchmark_returns[name].append(benchmark_return)
            fold_benchmarks[name] = benchmark
            fold_excess[name] = _rounded(
                strategy_return - benchmark_return
            )
        folds.append({
            "window": {
                key: value
                for key, value in window.items()
                if key != "testDates"
            },
            "selectedCandidateId": selected["candidateId"],
            "selectedSpecVersion": selected["strategy"]["specVersion"],
            "selection": selection,
            "metrics": backtest["metrics"],
            "benchmarks": fold_benchmarks,
            "excessReturns": fold_excess,
            "trades": backtest["trades"],
            "rejections": backtest["rejections"],
            "openPositions": backtest["openPositions"],
        })

    strategy_compounded = (
        math.prod(1.0 + value for value in strategy_returns) - 1.0
    )
    benchmark_summary = {}
    for name, returns in benchmark_returns.items():
        compounded = math.prod(1.0 + value for value in returns) - 1.0
        excess = [
            strategy - benchmark
            for strategy, benchmark in zip(strategy_returns, returns)
        ]
        benchmark_summary[name] = {
            "compoundedReturn": _rounded(compounded),
            "compoundedExcessReturn": _rounded(
                strategy_compounded - compounded
            ),
            "positiveExcessFolds": sum(value > 0 for value in excess),
            "meanFoldExcessReturn": _rounded(
                sum(excess) / len(excess)
            ),
            "worstFoldExcessReturn": _rounded(min(excess)),
        }
    return {
        "schemaVersion": "strategy-nested-walk-forward.v1",
        "datasetSchemaVersion": dataset["schemaVersion"],
        "methodology": {
            "kind": "PURGED_NESTED_EXPANDING_WINDOW",
            "outerMinimumTrainDays": int(outer_minimum_train_days),
            "outerPurgeDays": int(outer_purge_days),
            "outerTestDays": int(outer_test_days),
            "outerStepDays": int(outer_step_days),
            "innerMinimumTrainDays": int(inner_minimum_train_days),
            "innerPurgeDays": int(inner_purge_days),
            "innerTestDays": int(inner_test_days),
            "innerStepDays": int(inner_step_days),
            "foldCapitalReset": True,
            "outerTestUsedForSelection": False,
        },
        "candidateCount": len(validated_candidates),
        "foldCount": len(folds),
        "folds": folds,
        "summary": {
            "compoundedStrategyReturn": _rounded(strategy_compounded),
            "positiveStrategyFolds": sum(
                value > 0 for value in strategy_returns
            ),
            "worstStrategyFoldReturn": _rounded(min(strategy_returns)),
            "selectionCounts": selection_counts,
            "benchmarks": benchmark_summary,
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
    parser.add_argument("--candidates", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--benchmarks", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--outer-minimum-train-days", type=int, default=60)
    parser.add_argument("--outer-purge-days", type=int, default=5)
    parser.add_argument("--outer-test-days", type=int, default=20)
    parser.add_argument("--outer-step-days", type=int, default=20)
    parser.add_argument("--inner-minimum-train-days", type=int, default=30)
    parser.add_argument("--inner-purge-days", type=int, default=5)
    parser.add_argument("--inner-test-days", type=int, default=10)
    parser.add_argument("--inner-step-days", type=int, default=10)
    parser.add_argument("--initial-cash", type=float, default=1_000_000)
    args = parser.parse_args(argv)
    catalog = _read_json(args.candidates)
    benchmark_payload = _read_json(args.benchmarks)
    report = run_nested_walk_forward(
        catalog.get("candidates"),
        _read_json(args.dataset),
        benchmark_payload.get("benchmarks"),
        outer_minimum_train_days=args.outer_minimum_train_days,
        outer_purge_days=args.outer_purge_days,
        outer_test_days=args.outer_test_days,
        outer_step_days=args.outer_step_days,
        inner_minimum_train_days=args.inner_minimum_train_days,
        inner_purge_days=args.inner_purge_days,
        inner_test_days=args.inner_test_days,
        inner_step_days=args.inner_step_days,
        initial_cash=args.initial_cash,
    )
    _write_json(args.out, report)
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2))
    print("STRATEGY_NESTED_WALK_FORWARD_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
