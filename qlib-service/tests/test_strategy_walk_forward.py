import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from strategy_contract import strategy_fingerprint
from strategy_walk_forward import (
    build_walk_forward_windows,
    run_walk_forward,
)


def strategy():
    value = {
        "schemaVersion": "strategy-spec.v1",
        "strategyId": "walk-forward-test",
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


def bar(date, quant_score, close=10.0):
    return {
        "date": date,
        "code": "600001.SH",
        "name": "样本",
        "open": close,
        "high": close + 0.2,
        "low": close - 0.2,
        "close": close,
        "previousClose": close,
        "volume": 100_000,
        "marketScore": 70,
        "pct": 0,
        "volRatio": 1.5,
        "quant": {
            "score": quant_score,
            "upProb": quant_score,
            "expRet": 1,
            "highConfFired": False,
        },
    }


class WalkForwardWindowTest(unittest.TestCase):
    def test_builds_expanding_windows_with_purge_and_disjoint_tests(self):
        dates = ["202601%02d" % day for day in range(1, 21)]

        windows = build_walk_forward_windows(
            dates,
            minimum_train_days=6,
            purge_days=1,
            test_days=4,
            step_days=4,
        )

        self.assertEqual(windows[0]["trainEnd"], "20260106")
        self.assertEqual(windows[0]["purgeDates"], ["20260107"])
        self.assertEqual(
            windows[0]["testDates"],
            ["20260108", "20260109", "20260110", "20260111"],
        )
        self.assertEqual(windows[1]["trainEnd"], "20260110")
        self.assertTrue(
            set(windows[0]["testDates"]).isdisjoint(
                windows[1]["testDates"]
            )
        )

    def test_rejects_overlapping_test_steps(self):
        with self.assertRaisesRegex(ValueError, "step_days"):
            build_walk_forward_windows(
                ["202601%02d" % day for day in range(1, 21)],
                minimum_train_days=6,
                purge_days=1,
                test_days=4,
                step_days=2,
            )


class WalkForwardEvaluationTest(unittest.TestCase):
    def test_runs_only_test_dates_and_aggregates_fold_returns(self):
        dates = ["202601%02d" % day for day in range(1, 17)]
        bars = [
            bar(date, 80 if index in (7, 11) else 0)
            for index, date in enumerate(dates)
        ]
        dataset = {
            "schemaVersion": "strategy-dataset.v1",
            "quality": {"usable": True},
            "bars": bars,
        }

        report = run_walk_forward(
            strategy(),
            dataset,
            minimum_train_days=6,
            purge_days=1,
            test_days=4,
            step_days=4,
            initial_cash=100_000,
        )

        self.assertEqual(report["schemaVersion"], "strategy-walk-forward.v1")
        self.assertEqual(report["foldCount"], 2)
        self.assertEqual(
            report["folds"][0]["window"]["testStart"],
            "20260108",
        )
        self.assertEqual(
            report["folds"][1]["window"]["testStart"],
            "20260112",
        )
        self.assertTrue(all(
            item["window"]["trainEnd"] < item["window"]["testStart"]
            for item in report["folds"]
        ))
        self.assertEqual(
            report["summary"]["testedDates"],
            8,
        )

    def test_refuses_dataset_that_failed_quality_gate(self):
        with self.assertRaisesRegex(ValueError, "quality gate"):
            run_walk_forward(
                strategy(),
                {
                    "schemaVersion": "strategy-dataset.v1",
                    "quality": {"usable": False},
                    "bars": [],
                },
                minimum_train_days=6,
                purge_days=1,
                test_days=4,
                step_days=4,
            )


if __name__ == "__main__":
    unittest.main()
