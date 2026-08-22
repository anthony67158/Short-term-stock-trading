import copy
import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from strategy_research_dataset_v2 import build_strategy_dataset_v2


def panel(*, timeframe="1d", final_signal_close=10.7):
    return {
        "timeframe": timeframe,
        "dates": np.array([
            "202608200930",
            "202608200935",
            "202608200940",
        ]) if timeframe == "5m" else np.array([
            "20260818",
            "20260819",
            "20260820",
        ]),
        "o": np.array([10.0, 10.1, 10.2]),
        "h": np.array([10.2, 10.4, 10.6]),
        "l": np.array([9.9, 10.0, 10.1]),
        "c": np.array([10.1, 10.3, 10.5]),
        "qfq_o": np.array([9.8, 9.9, 10.0]),
        "qfq_h": np.array([10.0, 10.2, 10.8]),
        "qfq_l": np.array([9.7, 9.8, 9.9]),
        "qfq_c": np.array([9.9, 10.1, final_signal_close]),
        "v": np.array([100_000, 120_000, 140_000]),
        "amount": np.array([100_000, 120_000, 140_000]),
        "adj_factor": np.array([1.0, 1.0, 1.1]),
        "is_st": np.array([False, False, False]),
        "is_suspended": np.array([False, False, False]),
        "listing_days": np.array([200, 201, 202]),
        "bar_complete": np.array([True, True, True]),
        "amount_unit": "THOUSAND_CNY",
        "volume_unit": "SHARES",
        "f_atr_pct": np.array([2.0, 2.1, 2.2]),
        "f_rsi6": np.array([40.0, 42.0, 44.0]),
    }


class StrategyResearchDatasetV2Test(unittest.TestCase):
    def test_keeps_qfq_signal_and_raw_execution_prices_separate(self):
        predictions = {
            ("20260819", "600001.SH"): {
                "quantScore": 72.0,
                "scoreSource": "oos:model-v1",
            },
        }
        dataset = build_strategy_dataset_v2(
            {"600001.SH": panel()},
            predictions,
            timeframe="1d",
            minimum_history=2,
            source_metadata={
                "provider": "TUSHARE",
                "datasetVersion": "fixture-v1",
            },
            generated_at="2026-08-22T00:00:00Z",
        )

        self.assertEqual(dataset["schemaVersion"], "strategy-dataset.v2")
        self.assertEqual(dataset["quality"]["usable"], True)
        self.assertEqual(len(dataset["bars"]), 1)
        row = dataset["bars"][0]
        self.assertEqual(row["signalPrice"]["adjustment"], "QFQ")
        self.assertEqual(row["signalPrice"]["close"], 10.1)
        self.assertEqual(row["executionPrice"]["adjustment"], "RAW")
        self.assertEqual(row["executionPrice"]["close"], 10.3)
        self.assertEqual(row["adjustmentFactor"], 1.0)
        self.assertEqual(row["technical"]["atrPct"], 2.1)
        self.assertEqual(row["isSt"], False)
        self.assertEqual(row["isSuspended"], False)
        self.assertEqual(
            dataset["manifest"]["priceStreams"],
            {"signal": "QFQ", "execution": "RAW"},
        )
        self.assertEqual(len(dataset["manifest"]["contentSha256"]), 64)
        self.assertEqual(dataset["quality"]["futureFieldsUsed"], [])

    def test_future_signal_price_change_does_not_change_prior_record(self):
        predictions = {
            ("20260819", "600001.SH"): {
                "quantScore": 72.0,
                "scoreSource": "oos:model-v1",
            },
        }
        first = build_strategy_dataset_v2(
            {"600001.SH": panel(final_signal_close=10.7)},
            predictions,
            timeframe="1d",
            minimum_history=2,
        )
        second = build_strategy_dataset_v2(
            {"600001.SH": panel(final_signal_close=99.0)},
            predictions,
            timeframe="1d",
            minimum_history=2,
        )

        self.assertEqual(first["bars"], second["bars"])

    def test_rejects_unfinished_five_minute_bar_and_missing_adjustment(self):
        intraday = panel(timeframe="5m")
        intraday["bar_complete"][1] = False
        predictions = {
            ("202608200935", "600001.SH"): {
                "quantScore": 70.0,
                "scoreSource": "oos:5m",
            },
        }

        incomplete = build_strategy_dataset_v2(
            {"600001.SH": intraday},
            predictions,
            timeframe="5m",
            minimum_history=2,
        )
        no_adjustment = copy.deepcopy(intraday)
        no_adjustment["bar_complete"][1] = True
        del no_adjustment["adj_factor"]
        missing = build_strategy_dataset_v2(
            {"600001.SH": no_adjustment},
            predictions,
            timeframe="5m",
            minimum_history=2,
        )

        self.assertEqual(incomplete["quality"]["usable"], False)
        self.assertIn(
            "incompleteBar",
            incomplete["quality"]["missingRequiredFields"],
        )
        self.assertEqual(missing["quality"]["usable"], False)
        self.assertIn(
            "adj_factor",
            missing["quality"]["missingRequiredFields"],
        )


if __name__ == "__main__":
    unittest.main()
