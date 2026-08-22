import copy
import json
import os
import sys
import unittest
from unittest import mock


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
PROJECT_ROOT = os.path.abspath(os.path.join(SERVICE_ROOT, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

import strategy_walk_forward_v2 as walk_forward
from strategy_contract_v2 import strategy_fingerprint_v2


def strategy(threshold):
    path = os.path.join(
        PROJECT_ROOT,
        "shared",
        "fixtures",
        "strategy-spec-v2-conformance.json",
    )
    with open(path, encoding="utf-8") as handle:
        value = copy.deepcopy(
            next(
                item for item in json.load(handle)["cases"]
                if item["valid"]
            )["spec"]
        )
    value["strategyId"] = "trend-breakout"
    value["entry"]["conditions"][-1]["value"] = threshold
    value["specVersion"] = strategy_fingerprint_v2(value)
    return value


def bar(timestamp):
    return {
        "timestamp": timestamp,
        "date": timestamp[:8],
        "timeframe": "1d",
        "barClosed": True,
        "code": "600001.SH",
        "signalPrice": {
            "adjustment": "QFQ",
            "open": 10,
            "high": 10.2,
            "low": 9.8,
            "close": 10,
        },
        "executionPrice": {
            "adjustment": "RAW",
            "open": 10,
            "high": 10.2,
            "low": 9.8,
            "close": 10,
            "previousClose": 10,
        },
        "volume": 100_000,
        "amount": 100_000_000,
        "adv20": 100_000_000,
        "listingDays": 200,
        "isSt": False,
        "isSuspended": False,
        "marketRegime": "TREND_STRONG",
        "marketScore": 70,
        "pct": 0,
        "volRatio": 1.5,
        "quant": {"score": 80},
        "technical": {
            "donchianBreakout": True,
            "maSlope20": 0.5,
        },
    }


def fake_backtest(total_return, drawdown=-0.03):
    return {
        "schemaVersion": "strategy-backtest.v2",
        "metrics": {
            "totalReturn": total_return,
            "maximumDrawdown": drawdown,
            "closedTrades": 4,
            "totalFees": 20,
            "estimatedImpactCost": 5,
        },
        "fills": [],
        "trades": [],
        "rejections": [],
    }


class StrategyWalkForwardV2Test(unittest.TestCase):
    def test_inner_selection_never_reads_outer_test_and_reports_benchmarks(self):
        timestamps = ["202601%02d" % day for day in range(1, 21)]
        dataset = {
            "schemaVersion": "strategy-dataset.v2",
            "manifest": {
                "timeframe": "1d",
                "contentSha256": "b" * 64,
                "priceStreams": {"signal": "QFQ", "execution": "RAW"},
            },
            "quality": {"usable": True},
            "bars": [bar(timestamp) for timestamp in timestamps],
        }
        strategy_a = strategy(60)
        strategy_b = strategy(70)
        candidates = [
            {
                "candidateId": "trend-a",
                "hypothesis": "较宽确认",
                "strategy": strategy_a,
            },
            {
                "candidateId": "trend-b",
                "hypothesis": "较严确认",
                "strategy": strategy_b,
            },
        ]
        benchmark = {
            timestamp: 100 + index
            for index, timestamp in enumerate(timestamps)
        }
        calls = []

        def fake_run(spec, data, **_options):
            used = [item["timestamp"] for item in data["bars"]]
            calls.append((spec["strategyId"], used))
            if len(used) == 2:
                return fake_backtest(
                    0.02
                    if spec["specVersion"] == strategy_a["specVersion"]
                    else -0.01
                )
            return fake_backtest(0.03)

        with mock.patch.object(
            walk_forward,
            "run_strategy_backtest_v2",
            side_effect=fake_run,
        ):
            report = walk_forward.run_nested_walk_forward_v2(
                candidates,
                dataset,
                {"CSI300": benchmark, "CSI1000": benchmark},
                outer_minimum_train_bars=6,
                outer_purge_bars=1,
                outer_test_bars=4,
                outer_step_bars=4,
                inner_minimum_train_bars=2,
                inner_purge_bars=1,
                inner_test_bars=2,
                inner_step_bars=2,
                initial_cash=100_000,
            )

        self.assertEqual(
            report["schemaVersion"],
            "strategy-nested-walk-forward.v2",
        )
        self.assertEqual(report["foldCount"], 3)
        self.assertEqual(
            report["deploymentSelection"]["candidateId"],
            "trend-a",
        )
        self.assertEqual(
            report["specVersion"],
            report["deploymentSelection"]["specVersion"],
        )
        self.assertTrue(all(
            fold["selectedCandidateId"] == "trend-a"
            for fold in report["folds"]
        ))
        self.assertTrue(all(
            fold["selection"]["latestValidationTimestamp"]
            < fold["window"]["testStart"]
            for fold in report["folds"]
        ))
        self.assertTrue(calls)

    def test_promotion_gate_requires_six_folds_cost_and_capacity_resilience(self):
        report = {
            "schemaVersion": "strategy-nested-walk-forward.v2",
            "strategyId": "trend-breakout",
            "specVersion": "strategy.test",
            "foldCount": 6,
            "summary": {
                "positiveStrategyFolds": 5,
                "compoundedStrategyReturn": 0.12,
                "worstMaximumDrawdown": -0.08,
                "benchmarks": {
                    "CSI300": {
                        "positiveExcessFolds": 5,
                        "compoundedExcessReturn": 0.06,
                    },
                    "CSI1000": {
                        "positiveExcessFolds": 5,
                        "compoundedExcessReturn": 0.04,
                    },
                },
            },
        }
        stress = {
            "schemaVersion": "strategy-capacity-stress.v1",
            "strategyId": "trend-breakout",
            "specVersion": "strategy.test",
            "scenarios": [
                {
                    "initialCash": capital,
                    "slippageBps": slippage,
                    "totalReturn": 0.08,
                    "queuedOrders": 0,
                }
                for capital in (100000, 500000, 1000000, 5000000)
                for slippage in (5, 10, 20)
            ],
        }

        passed = walk_forward.evaluate_strategy_promotion_v2(
            report,
            stress,
        )
        failed = walk_forward.evaluate_strategy_promotion_v2(
            {
                **report,
                "foldCount": 4,
                "summary": {
                    **report["summary"],
                    "positiveStrategyFolds": 2,
                },
            },
            stress,
        )

        self.assertEqual(passed["decision"], "promote")
        self.assertEqual(passed["blockers"], [])
        self.assertEqual(failed["decision"], "reject")
        self.assertIn(
            "INSUFFICIENT_OUTER_FOLDS",
            [item["code"] for item in failed["blockers"]],
        )


if __name__ == "__main__":
    unittest.main()
