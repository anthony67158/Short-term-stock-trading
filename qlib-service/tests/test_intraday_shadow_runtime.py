import importlib.util
import os
import sys
import unittest
from datetime import datetime, timedelta

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODULE_PATH = os.path.join(SERVICE_ROOT, "intraday_shadow_runtime.py")


def load_runtime():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "intraday_shadow_runtime",
            MODULE_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(SERVICE_ROOT)


class IntradayShadowRuntimeTest(unittest.TestCase):
    def test_formats_a_shadow_only_prediction(self):
        runtime = load_runtime()
        start = datetime(2026, 8, 10, 9, 35)
        times = np.asarray([
            (start + timedelta(minutes=index * 5)).strftime(
                "%Y-%m-%d %H:%M:%S"
            )
            for index in range(61)
        ])
        times[-1] = "2026-08-10 15:00:00"
        closes = np.linspace(10.0, 10.6, 61)

        response = runtime.format_shadow_prediction(
            request={
                "request_id": "shadow_600519",
                "code": "600519.SH",
                "as_of": "2026-08-10 15:00:00",
                "panel": {
                    "trade_time": times,
                    "open": closes - 0.01,
                    "high": closes + 0.05,
                    "low": closes - 0.05,
                    "close": closes,
                    "vol": np.linspace(1000, 1800, 61),
                    "amount": np.zeros(61),
                },
            },
            probabilities=[0.2, 0.1, 0.7],
            model_metadata={
                "run_id": "run-20260811-minute5m-v2",
                "architecture": "transformer",
                "sha256": "a" * 64,
            },
        )

        self.assertTrue(response["ok"])
        self.assertTrue(response["shadowOnly"])
        self.assertEqual(response["predictedClass"], "TAKE_PROFIT")
        self.assertEqual(response["probabilities"]["takeProfit"], 0.7)
        self.assertEqual(response["outlook"]["direction"], "bullish")
        self.assertEqual(response["outlook"]["confidencePct"], 70.0)
        self.assertEqual(response["outlook"]["probabilityMarginPct"], 50.0)
        self.assertEqual(response["outlook"]["expectedBarrierReturnPct"], 0.58)
        self.assertEqual(response["outlook"]["directionScore"], 75)
        self.assertEqual(response["outlook"]["riskLevel"], "medium")
        self.assertEqual(response["outlook"]["signalStrength"], "strong")
        self.assertEqual(response["outlook"]["probabilityEdgePct"], 50.0)
        self.assertEqual(response["outlook"]["favorableToAdverseOdds"], 3.5)
        self.assertIn(response["outlook"]["uncertaintyLevel"], ("low", "medium", "high"))
        self.assertGreaterEqual(response["outlook"]["convictionScore"], 0)
        self.assertLessEqual(response["outlook"]["convictionScore"], 100)
        self.assertGreater(response["outlook"]["normalizedEntropy"], 0)
        self.assertLess(response["outlook"]["normalizedEntropy"], 1)
        context = response["marketContext"]
        self.assertEqual(context["barsCount"], 61)
        self.assertEqual(context["sessionBars"], 61)
        self.assertGreater(context["sessionReturnPct"], 0)
        self.assertGreater(context["momentum30mPct"], 0)
        self.assertGreater(context["realizedVolPct"], 0)
        self.assertGreater(context["volumeRatio20"], 1)
        self.assertGreater(context["closeLocationPct"], 50)
        self.assertLessEqual(context["drawdownFromHighPct"], 0)
        self.assertGreaterEqual(context["reboundFromLowPct"], 0)
        self.assertEqual(context["trendAlignment"], "bullish")
        prices = response["priceReferences"]
        self.assertEqual(prices["anchorType"], "signalClose")
        self.assertEqual(prices["anchorPrice"], 10.6)
        self.assertEqual(prices["indicativeTakeProfitPrice"], 10.71)
        self.assertEqual(prices["indicativeStopLossPrice"], 10.54)
        self.assertEqual(prices["supportPrice"], context["supportPrice"])
        self.assertEqual(prices["resistancePrice"], context["resistancePrice"])
        self.assertTrue(prices["provisional"])
        self.assertEqual(
            response["targetDefinition"],
            {
                "entry": "nextTradingDayFirst5mOpen",
                "horizon": "nextTradingDay",
                "takeProfitPct": 1.0,
                "stopLossPct": 0.6,
                "sameBarPolicy": "stopLossFirst",
            },
        )
        self.assertNotIn("action", response)
        self.assertNotIn("decision", response)

    def test_rejects_invalid_probability_vectors(self):
        runtime = load_runtime()
        request = {
            "request_id": None,
            "code": "600519.SH",
            "as_of": "2026-08-10 15:00:00",
        }
        metadata = {
            "run_id": "run-20260811-minute5m-v2",
            "architecture": "transformer",
            "sha256": "a" * 64,
        }

        with self.assertRaisesRegex(ValueError, "概率"):
            runtime.format_shadow_prediction(
                request=request,
                probabilities=[0.5, 0.5],
                model_metadata=metadata,
            )
