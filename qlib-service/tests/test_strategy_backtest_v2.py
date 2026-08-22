import copy
import json
import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
PROJECT_ROOT = os.path.abspath(os.path.join(SERVICE_ROOT, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from strategy_backtest_v2 import (
    run_capacity_stress,
    run_strategy_backtest_v2,
)
from strategy_contract_v2 import strategy_fingerprint_v2


def strategy():
    path = os.path.join(
        PROJECT_ROOT,
        "shared",
        "fixtures",
        "strategy-spec-v2-conformance.json",
    )
    with open(path, encoding="utf-8") as handle:
        fixture = json.load(handle)
    value = copy.deepcopy(
        next(item for item in fixture["cases"] if item["valid"])["spec"]
    )
    value["liquidityLimits"]["maximumParticipationRate"] = 0.05
    value["specVersion"] = strategy_fingerprint_v2(value)
    return value


def bar(
    timestamp,
    *,
    raw_open=10.0,
    raw_close=10.0,
    signal_close=10.0,
    volume=2_000,
    signal=True,
):
    date = timestamp[:8]
    return {
        "timestamp": timestamp,
        "date": date,
        "timeframe": "1d",
        "barClosed": True,
        "code": "600001.SH",
        "name": "样本",
        "industry": "测试行业",
        "signalPrice": {
            "adjustment": "QFQ",
            "open": signal_close,
            "high": signal_close * 1.02,
            "low": signal_close * 0.98,
            "close": signal_close,
        },
        "executionPrice": {
            "adjustment": "RAW",
            "open": raw_open,
            "high": max(raw_open, raw_close) * 1.01,
            "low": min(raw_open, raw_close) * 0.99,
            "close": raw_close,
            "previousClose": 10.0,
        },
        "volume": volume,
        "amount": 100_000_000,
        "adv20": 100_000_000,
        "listingDays": 200,
        "isSt": False,
        "isSuspended": False,
        "marketRegime": "TREND_STRONG",
        "marketScore": 75,
        "pct": 1,
        "volRatio": 1.8,
        "quant": {"score": 72},
        "technical": {
            "donchianBreakout": signal,
            "maSlope20": 0.8 if signal else -0.2,
            "structureBreak": not signal,
        },
    }


def dataset():
    bars = [
        bar("20260818", signal=True),
        bar("20260819", raw_close=10.6, signal=False),
        bar("20260820", raw_open=10.7, raw_close=10.8, signal=False),
        bar("20260821", raw_open=10.9, raw_close=10.9, signal=False),
    ]
    return {
        "schemaVersion": "strategy-dataset.v2",
        "manifest": {
            "contentSha256": "a" * 64,
            "timeframe": "1d",
            "priceStreams": {"signal": "QFQ", "execution": "RAW"},
        },
        "quality": {"usable": True},
        "bars": bars,
    }


class StrategyBacktestV2Test(unittest.TestCase):
    def test_applies_capacity_partial_fills_and_reports_risk_metrics(self):
        report = run_strategy_backtest_v2(
            strategy(),
            dataset(),
            initial_cash=100_000,
            slippage_bps=5,
        )

        self.assertEqual(report["schemaVersion"], "strategy-backtest.v2")
        self.assertEqual(report["datasetHash"], "a" * 64)
        self.assertGreater(report["metrics"]["partialFills"], 0)
        self.assertGreater(report["metrics"]["turnover"], 0)
        self.assertIn("sharpe", report["metrics"])
        self.assertIn("sortino", report["metrics"])
        self.assertIn("calmar", report["metrics"])
        self.assertIn("drawdownRecoveryBars", report["metrics"])
        self.assertIn("averageHoldingBars", report["metrics"])
        self.assertIn("averageCashExposurePct", report["metrics"])
        self.assertIn("maximumIndustryExposurePct", report["metrics"])
        self.assertTrue(all(
            fill["quantity"] <= 100
            for fill in report["fills"]
        ))
        self.assertGreater(report["metrics"]["estimatedImpactCost"], 0)

    def test_capacity_and_slippage_matrix_covers_all_required_scenarios(self):
        report = run_capacity_stress(strategy(), dataset())

        self.assertEqual(
            report["schemaVersion"],
            "strategy-capacity-stress.v1",
        )
        self.assertEqual(len(report["scenarios"]), 12)
        self.assertEqual(
            {item["initialCash"] for item in report["scenarios"]},
            {100000, 500000, 1000000, 5000000},
        )
        self.assertEqual(
            {item["slippageBps"] for item in report["scenarios"]},
            {5, 10, 20},
        )
        largest = [
            item for item in report["scenarios"]
            if item["initialCash"] == 5000000
        ]
        self.assertTrue(all(
            item["capacityUtilizationPct"] <= 100
            for item in largest
        ))

    def test_rejects_incomplete_bars_and_wrong_price_streams(self):
        broken = dataset()
        broken["bars"][0]["barClosed"] = False
        with self.assertRaisesRegex(ValueError, "completed"):
            run_strategy_backtest_v2(strategy(), broken)

        adjusted = dataset()
        adjusted["bars"][0]["executionPrice"]["adjustment"] = "QFQ"
        with self.assertRaisesRegex(ValueError, "RAW"):
            run_strategy_backtest_v2(strategy(), adjusted)


if __name__ == "__main__":
    unittest.main()
