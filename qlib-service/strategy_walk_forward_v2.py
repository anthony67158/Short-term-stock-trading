"""Nested, purged walk-forward evaluation for StrategySpec v2."""

import argparse
import gzip
import json
import math
import os
import re

from strategy_backtest_v2 import (
    run_capacity_stress,
    run_strategy_backtest_v2,
)
from strategy_contract_v2 import validate_strategy_spec_v2
from strategy_walk_forward import build_walk_forward_windows


def _rounded(value):
    return round(float(value), 6)


def _read_json(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(path, payload):
    output = os.path.abspath(path)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    temporary = "%s.tmp.%d" % (output, os.getpid())
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def _dataset_slice(dataset, allowed):
    bars = [
        item for item in dataset["bars"]
        if str(item["timestamp"]) in allowed
    ]
    return {
        **dataset,
        "quality": {**dataset["quality"], "usable": bool(bars)},
        "bars": bars,
    }


def _validate_candidates(candidates, dataset):
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("at least one pre-registered candidate is required")
    output = []
    ids = set()
    versions = set()
    families = set()
    strategy_ids = set()
    timeframe = (dataset.get("manifest") or {}).get("timeframe")
    for item in candidates:
        if not isinstance(item, dict):
            raise ValueError("candidate must be an object")
        candidate_id = str(item.get("candidateId", ""))
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,63}", candidate_id):
            raise ValueError("invalid candidateId")
        if candidate_id in ids:
            raise ValueError("duplicate candidateId")
        hypothesis = str(item.get("hypothesis", "")).strip()
        if not hypothesis:
            raise ValueError("candidate hypothesis is required")
        strategy = validate_strategy_spec_v2(item.get("strategy"))
        if strategy["signalTimeframe"] != timeframe:
            raise ValueError("candidate timeframe does not match dataset")
        if strategy["specVersion"] in versions:
            raise ValueError("candidate strategy versions must be distinct")
        ids.add(candidate_id)
        versions.add(strategy["specVersion"])
        families.add(strategy["family"])
        strategy_ids.add(strategy["strategyId"])
        output.append({
            "candidateId": candidate_id,
            "hypothesis": hypothesis,
            "strategy": strategy,
        })
    if len(families) != 1:
        raise ValueError("one nested evaluation may contain only one strategy family")
    if len(strategy_ids) != 1:
        raise ValueError("candidate revisions must share one strategyId")
    return output


def _benchmark_return(series, test_timestamps):
    if not isinstance(series, dict):
        raise ValueError("benchmark series must be timestamp keyed")
    values = []
    for timestamp in test_timestamps:
        value = series.get(str(timestamp))
        try:
            close = float(value)
        except (TypeError, ValueError):
            raise ValueError("missing benchmark timestamp: %s" % timestamp)
        if not math.isfinite(close) or close <= 0:
            raise ValueError("invalid benchmark value: %s" % timestamp)
        values.append(close)
    return {
        "startTimestamp": test_timestamps[0],
        "endTimestamp": test_timestamps[-1],
        "totalReturn": _rounded(values[-1] / values[0] - 1.0),
        "coveredBars": len(values),
    }


def _inner_score(
    candidate,
    dataset,
    *,
    minimum_train_bars,
    purge_bars,
    test_bars,
    step_bars,
    initial_cash,
):
    timestamps = sorted({
        str(item["timestamp"]) for item in dataset["bars"]
    })
    windows = build_walk_forward_windows(
        timestamps,
        minimum_train_days=minimum_train_bars,
        purge_days=purge_bars,
        test_days=test_bars,
        step_days=step_bars,
    )
    returns = []
    validations = []
    for window in windows:
        allowed = set(window["testDates"])
        report = run_strategy_backtest_v2(
            candidate["strategy"],
            _dataset_slice(dataset, allowed),
            initial_cash=initial_cash,
        )
        total_return = float(report["metrics"]["totalReturn"])
        returns.append(total_return)
        validations.append({
            "validationStart": window["testStart"],
            "validationEnd": window["testEnd"],
            "totalReturn": _rounded(total_return),
            "maximumDrawdown": report["metrics"]["maximumDrawdown"],
            "closedTrades": report["metrics"]["closedTrades"],
        })
    compounded = math.prod(1 + value for value in returns) - 1
    return {
        "candidateId": candidate["candidateId"],
        "specVersion": candidate["strategy"]["specVersion"],
        "positiveFoldRate": _rounded(
            sum(value > 0 for value in returns) / len(returns)
        ),
        "compoundedReturn": _rounded(compounded),
        "worstFoldReturn": _rounded(min(returns)),
        "validations": validations,
    }


def _selection_key(score):
    return (
        -score["positiveFoldRate"],
        -score["compoundedReturn"],
        -score["worstFoldReturn"],
        score["candidateId"],
    )


def run_nested_walk_forward_v2(
    candidates,
    dataset,
    benchmarks,
    *,
    outer_minimum_train_bars,
    outer_purge_bars,
    outer_test_bars,
    outer_step_bars,
    inner_minimum_train_bars,
    inner_purge_bars,
    inner_test_bars,
    inner_step_bars,
    initial_cash=1_000_000,
):
    if (
        not isinstance(dataset, dict)
        or dataset.get("schemaVersion") != "strategy-dataset.v2"
        or (dataset.get("quality") or {}).get("usable") is not True
    ):
        raise ValueError("strategy dataset v2 failed quality gate")
    validated = _validate_candidates(candidates, dataset)
    if set(benchmarks or {}) != {"CSI300", "CSI1000"}:
        raise ValueError("CSI300 and CSI1000 benchmarks are required")
    timestamps = sorted({
        str(item["timestamp"]) for item in dataset["bars"]
    })
    outer_windows = build_walk_forward_windows(
        timestamps,
        minimum_train_days=outer_minimum_train_bars,
        purge_days=outer_purge_bars,
        test_days=outer_test_bars,
        step_days=outer_step_bars,
    )

    folds = []
    strategy_returns = []
    benchmark_returns = {"CSI300": [], "CSI1000": []}
    selection_counts = {}
    for window in outer_windows:
        train_allowed = {
            timestamp for timestamp in timestamps
            if window["trainStart"] <= timestamp <= window["trainEnd"]
        }
        test_allowed = set(window["testDates"])
        train_dataset = _dataset_slice(dataset, train_allowed)
        scores = [
            _inner_score(
                candidate,
                train_dataset,
                minimum_train_bars=inner_minimum_train_bars,
                purge_bars=inner_purge_bars,
                test_bars=inner_test_bars,
                step_bars=inner_step_bars,
                initial_cash=initial_cash,
            )
            for candidate in validated
        ]
        scores.sort(key=_selection_key)
        selected_score = scores[0]
        selected = next(
            candidate for candidate in validated
            if candidate["candidateId"] == selected_score["candidateId"]
        )
        latest_validation = max(
            validation["validationEnd"]
            for score in scores
            for validation in score["validations"]
        )
        if latest_validation >= window["testStart"]:
            raise ValueError("inner validation leaked into outer test")
        backtest = run_strategy_backtest_v2(
            selected["strategy"],
            _dataset_slice(dataset, test_allowed),
            initial_cash=initial_cash,
        )
        strategy_return = float(backtest["metrics"]["totalReturn"])
        strategy_returns.append(strategy_return)
        selection_counts[selected["candidateId"]] = (
            selection_counts.get(selected["candidateId"], 0) + 1
        )
        fold_benchmarks = {}
        fold_excess = {}
        for name in ("CSI300", "CSI1000"):
            benchmark = _benchmark_return(
                benchmarks[name],
                window["testDates"],
            )
            benchmark_return = benchmark["totalReturn"]
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
            "selection": {
                "objective": (
                    "POSITIVE_FOLD_RATE_THEN_COMPOUNDED_RETURN_"
                    "THEN_WORST_FOLD_THEN_ID"
                ),
                "latestValidationTimestamp": latest_validation,
                "candidateScores": scores,
            },
            "metrics": backtest["metrics"],
            "benchmarks": fold_benchmarks,
            "excessReturns": fold_excess,
        })

    compounded = math.prod(1 + value for value in strategy_returns) - 1
    benchmark_summary = {}
    for name, returns in benchmark_returns.items():
        benchmark_compounded = math.prod(1 + value for value in returns) - 1
        excess = [
            strategy_return - benchmark_return
            for strategy_return, benchmark_return
            in zip(strategy_returns, returns)
        ]
        benchmark_summary[name] = {
            "compoundedReturn": _rounded(benchmark_compounded),
            "compoundedExcessReturn": _rounded(
                compounded - benchmark_compounded
            ),
            "positiveExcessFolds": sum(value > 0 for value in excess),
            "meanFoldExcessReturn": _rounded(sum(excess) / len(excess)),
            "worstFoldExcessReturn": _rounded(min(excess)),
        }
    deployment_scores = [
        _inner_score(
            candidate,
            dataset,
            minimum_train_bars=inner_minimum_train_bars,
            purge_bars=inner_purge_bars,
            test_bars=inner_test_bars,
            step_bars=inner_step_bars,
            initial_cash=initial_cash,
        )
        for candidate in validated
    ]
    deployment_scores.sort(key=_selection_key)
    deployment_score = deployment_scores[0]
    deployment_candidate = next(
        candidate for candidate in validated
        if candidate["candidateId"] == deployment_score["candidateId"]
    )
    return {
        "schemaVersion": "strategy-nested-walk-forward.v2",
        "strategyId": deployment_candidate["strategy"]["strategyId"],
        "family": deployment_candidate["strategy"]["family"],
        "specVersion": deployment_candidate["strategy"]["specVersion"],
        "datasetHash": dataset["manifest"]["contentSha256"],
        "foldCount": len(folds),
        "methodology": {
            "kind": "PURGED_NESTED_EXPANDING_WINDOW",
            "outerTestUsedForSelection": False,
            "foldCapitalReset": True,
            "outerMinimumTrainBars": outer_minimum_train_bars,
            "outerPurgeBars": outer_purge_bars,
            "outerTestBars": outer_test_bars,
            "outerStepBars": outer_step_bars,
            "innerMinimumTrainBars": inner_minimum_train_bars,
            "innerPurgeBars": inner_purge_bars,
            "innerTestBars": inner_test_bars,
            "innerStepBars": inner_step_bars,
        },
        "deploymentSelection": {
            "candidateId": deployment_candidate["candidateId"],
            "specVersion": deployment_candidate["strategy"]["specVersion"],
            "selectedWithoutOuterTestFeedback": True,
            "candidateScores": deployment_scores,
        },
        "folds": folds,
        "summary": {
            "compoundedStrategyReturn": _rounded(compounded),
            "positiveStrategyFolds": sum(
                value > 0 for value in strategy_returns
            ),
            "worstStrategyFoldReturn": _rounded(min(strategy_returns)),
            "worstMaximumDrawdown": _rounded(min(
                float(fold["metrics"]["maximumDrawdown"])
                for fold in folds
            )),
            "selectionCounts": selection_counts,
            "benchmarks": benchmark_summary,
        },
    }


def _block(code, message):
    return {"code": code, "message": message}


def evaluate_strategy_promotion_v2(report, capacity_stress):
    if report.get("schemaVersion") != "strategy-nested-walk-forward.v2":
        raise ValueError("unsupported walk-forward report")
    if capacity_stress.get("schemaVersion") != "strategy-capacity-stress.v1":
        raise ValueError("unsupported capacity stress report")
    if (
        report.get("strategyId") != capacity_stress.get("strategyId")
        or report.get("specVersion") != capacity_stress.get("specVersion")
    ):
        raise ValueError("walk-forward and capacity artifacts must match")
    blockers = []
    folds = int(report.get("foldCount") or 0)
    summary = report.get("summary") or {}
    required_positive = math.ceil(folds * 0.67)
    positive = int(summary.get("positiveStrategyFolds") or 0)
    if folds < 6:
        blockers.append(_block(
            "INSUFFICIENT_OUTER_FOLDS",
            "外层测试窗口不足6个",
        ))
    if positive < required_positive:
        blockers.append(_block(
            "UNSTABLE_FOLD_RETURNS",
            "正收益外层窗口不足67%",
        ))
    drawdown = abs(min(0.0, float(
        summary.get("worstMaximumDrawdown") or 0
    )))
    if drawdown > 0.10:
        blockers.append(_block(
            "DRAWDOWN_TOO_HIGH",
            "费后最大回撤超过10%",
        ))
    for name in ("CSI300", "CSI1000"):
        benchmark = (summary.get("benchmarks") or {}).get(name) or {}
        if (
            float(benchmark.get("compoundedExcessReturn") or 0) <= 0
            or int(benchmark.get("positiveExcessFolds") or 0)
            < required_positive
        ):
            blockers.append(_block(
                "BENCHMARK_%s_FAILED" % name,
                "%s复合超额收益不稳定" % name,
            ))

    scenarios = capacity_stress.get("scenarios") or []
    expected_pairs = {
        (capital, slippage)
        for capital in (100000, 500000, 1000000, 5000000)
        for slippage in (5, 10, 20)
    }
    actual_pairs = {
        (
            int(item.get("initialCash") or 0),
            int(item.get("slippageBps") or 0),
        )
        for item in scenarios
    }
    if not expected_pairs.issubset(actual_pairs):
        blockers.append(_block(
            "CAPACITY_MATRIX_INCOMPLETE",
            "资金规模与滑点压力矩阵不完整",
        ))
    else:
        base = next(
            item for item in scenarios
            if int(item["initialCash"]) == 100000
            and int(item["slippageBps"]) == 5
        )
        largest_stress = next(
            item for item in scenarios
            if int(item["initialCash"]) == 5000000
            and int(item["slippageBps"]) == 20
        )
        degradation = (
            float(base.get("totalReturn") or 0)
            - float(largest_stress.get("totalReturn") or 0)
        )
        if degradation > 0.05:
            blockers.append(_block(
                "CAPACITY_RETURN_COLLAPSE",
                "大资金与高滑点场景收益退化超过5个百分点",
            ))
    return {
        "schemaVersion": "strategy-evaluation.v2",
        "strategyId": report["strategyId"],
        "specVersion": report["specVersion"],
        "decision": "promote" if not blockers else "reject",
        "thresholds": {
            "minimumOuterFolds": 6,
            "minimumPositiveFoldRate": 0.67,
            "maximumDrawdown": 0.10,
            "maximumCapacityDegradation": 0.05,
        },
        "metrics": {
            "folds": folds,
            "positiveFolds": positive,
            "maximumDrawdown": _rounded(drawdown),
            "benchmarks": summary.get("benchmarks") or {},
        },
        "blockers": blockers,
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--benchmarks", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--outer-minimum-train-bars", type=int, default=120)
    parser.add_argument("--outer-purge-bars", type=int, default=5)
    parser.add_argument("--outer-test-bars", type=int, default=20)
    parser.add_argument("--outer-step-bars", type=int, default=20)
    parser.add_argument("--inner-minimum-train-bars", type=int, default=60)
    parser.add_argument("--inner-purge-bars", type=int, default=5)
    parser.add_argument("--inner-test-bars", type=int, default=10)
    parser.add_argument("--inner-step-bars", type=int, default=10)
    parser.add_argument("--initial-cash", type=float, default=1_000_000)
    args = parser.parse_args(argv)
    catalog = _read_json(args.candidates)
    dataset = _read_json(args.dataset)
    benchmark_payload = _read_json(args.benchmarks)
    report = run_nested_walk_forward_v2(
        catalog.get("candidates"),
        dataset,
        benchmark_payload.get("benchmarks"),
        outer_minimum_train_bars=args.outer_minimum_train_bars,
        outer_purge_bars=args.outer_purge_bars,
        outer_test_bars=args.outer_test_bars,
        outer_step_bars=args.outer_step_bars,
        inner_minimum_train_bars=args.inner_minimum_train_bars,
        inner_purge_bars=args.inner_purge_bars,
        inner_test_bars=args.inner_test_bars,
        inner_step_bars=args.inner_step_bars,
        initial_cash=args.initial_cash,
    )
    selected_spec = next(
        candidate["strategy"]
        for candidate in catalog["candidates"]
        if candidate["strategy"]["specVersion"] == report["specVersion"]
    )
    stress = run_capacity_stress(selected_spec, dataset)
    evaluation = evaluate_strategy_promotion_v2(report, stress)
    output = {
        "walkForward": report,
        "capacityStress": stress,
        "evaluation": evaluation,
    }
    _write_json(args.out, output)
    print(json.dumps(evaluation, ensure_ascii=False, indent=2))
    print("STRATEGY_WALK_FORWARD_V2_OK")
    return 0 if evaluation["decision"] == "promote" else 2


if __name__ == "__main__":
    raise SystemExit(main())
