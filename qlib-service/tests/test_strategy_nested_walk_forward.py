import os
import sys
import unittest
from unittest import mock


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from strategy_contract import strategy_fingerprint
import strategy_nested_walk_forward as nested


def strategy(strategy_id):
    value = {
        "schemaVersion": "strategy-spec.v1",
        "strategyId": strategy_id,
        "entry": {
            "field": "quant.score",
            "op": "GTE",
            "value": 55,
        },
        "score": {
            "method": "WEIGHTED_SUM",
            "weights": {
                "marketScore": 0.4,
                "quantScore": 0.35,
                "upProb": 0.15,
                "expectedReturn": 0.1,
            },
            "bonuses": {"highConfidence": 5},
            "normalization": {
                "expectedReturnMin": -5,
                "expectedReturnMax": 5,
            },
        },
        "position": {
            "sizing": "EQUAL_WEIGHT",
            "allocationPct": 100,
            "maxPositions": 1,
            "lotSize": 100,
        },
        "exit": {
            "stopLossPct": 3,
            "takeProfitPct": 6,
            "maxHoldingDays": 2,
            "signalExit": None,
        },
        "execution": {
            "entryAt": "NEXT_OPEN",
            "exitAt": "NEXT_OPEN",
            "tPlusOne": True,
            "rejectLimitUpBuy": True,
            "rejectLimitDownSell": True,
            "slippageBps": 0,
            "feePolicy": "A_SHARE_STANDARD_V1",
        },
    }
    value["specVersion"] = strategy_fingerprint(value)
    return value


def bar(date):
    return {
        "date": date,
        "code": "600001.SH",
        "name": "样本",
        "open": 10,
        "high": 10.2,
        "low": 9.8,
        "close": 10,
        "previousClose": 10,
        "volume": 100_000,
        "marketScore": 70,
        "pct": 0,
        "volRatio": 1.5,
        "quant": {
            "score": 80,
            "upProb": 80,
            "expRet": 1,
            "highConfFired": False,
        },
    }


def fake_report(total_return):
    return {
        "metrics": {
            "totalReturn": total_return,
            "maximumDrawdown": min(total_return, 0),
            "closedTrades": 1,
            "rejectedOrders": 0,
            "totalFees": 10,
        },
        "trades": [],
        "rejections": [],
        "openPositions": [],
    }


class BenchmarkReturnTest(unittest.TestCase):
    def test_requires_every_test_date_and_computes_close_to_close_return(self):
        result = nested.benchmark_window_return(
            {
                "20260108": 100,
                "20260109": 102,
                "20260110": 104,
            },
            ["20260108", "20260109", "20260110"],
        )

        self.assertEqual(result["startClose"], 100)
        self.assertEqual(result["endClose"], 104)
        self.assertAlmostEqual(result["totalReturn"], 0.04)

        with self.assertRaisesRegex(ValueError, "missing benchmark date"):
            nested.benchmark_window_return(
                {"20260108": 100, "20260110": 104},
                ["20260108", "20260109", "20260110"],
            )


class NestedWalkForwardTest(unittest.TestCase):
    def test_selects_on_inner_train_only_and_reports_outer_excess_return(self):
        dates = ["202601%02d" % day for day in range(1, 17)]
        dataset = {
            "schemaVersion": "strategy-dataset.v1",
            "quality": {"usable": True},
            "bars": [bar(date) for date in dates],
        }
        candidates = [
            {
                "candidateId": "candidate-a",
                "hypothesis": "inner winner",
                "strategy": strategy("candidate-a"),
            },
            {
                "candidateId": "candidate-b",
                "hypothesis": "inner loser",
                "strategy": strategy("candidate-b"),
            },
        ]
        benchmark = {
            date: 100 + index
            for index, date in enumerate(dates)
        }
        calls = []

        def run_backtest(spec, bars, *, initial_cash):
            used_dates = sorted({item["date"] for item in bars})
            calls.append((spec["strategyId"], used_dates))
            if len(used_dates) == 2:
                return fake_report(
                    0.02 if spec["strategyId"] == "candidate-a" else -0.01
                )
            return fake_report(0.03)

        with mock.patch.object(
            nested,
            "run_portfolio_backtest",
            side_effect=run_backtest,
        ):
            report = nested.run_nested_walk_forward(
                candidates,
                dataset,
                {"CSI300": benchmark},
                outer_minimum_train_days=6,
                outer_purge_days=1,
                outer_test_days=4,
                outer_step_days=4,
                inner_minimum_train_days=2,
                inner_purge_days=1,
                inner_test_days=2,
                inner_step_days=2,
                initial_cash=100_000,
            )

        self.assertEqual(report["schemaVersion"], "strategy-nested-walk-forward.v1")
        self.assertEqual(report["foldCount"], 2)
        for fold in report["folds"]:
            self.assertEqual(fold["selectedCandidateId"], "candidate-a")
            self.assertLess(
                fold["selection"]["latestValidationDate"],
                fold["window"]["testStart"],
            )
            benchmark_return = fold["benchmarks"]["CSI300"]["totalReturn"]
            self.assertAlmostEqual(
                fold["excessReturns"]["CSI300"],
                0.03 - benchmark_return,
                places=6,
            )
        inner_calls = [
            used_dates for _strategy_id, used_dates in calls
            if len(used_dates) == 2
        ]
        self.assertTrue(inner_calls)
        self.assertTrue(all(
            max(used_dates) < report["folds"][-1]["window"]["testStart"]
            for used_dates in inner_calls[:2]
        ))


if __name__ == "__main__":
    unittest.main()
