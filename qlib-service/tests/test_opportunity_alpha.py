import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from decision_engine.training.opportunity_alpha import (  # noqa: E402
    aggregate_stock_day_targets,
    causal_feature_date,
)


class OpportunityAlphaTargetTest(unittest.TestCase):
    def test_causal_feature_date_uses_previous_day_for_intraday(self):
        dates = ["20260102", "20260105", "20260106"]

        self.assertEqual(
            causal_feature_date("2026-01-05", "INTRADAY", dates),
            "20260102",
        )
        self.assertEqual(
            causal_feature_date("2026-01-05", "CLOSE", dates),
            "20260105",
        )
        self.assertIsNone(
            causal_feature_date("2026-01-05", "UNKNOWN", dates),
        )

    def test_aggregate_uses_best_path_and_waits_for_every_path_to_mature(self):
        dataset = {
            "X_opportunity": np.zeros((3, 1)),
            "dates_opportunity": np.asarray([
                "2026-01-05",
                "2026-01-04",
                "2026-01-05",
            ]),
            "codes_opportunity": np.asarray(["600001"] * 3),
            "decision_ids_opportunity": np.asarray([
                "formula:2026-01-05:intraday:1030:600001:IMMEDIATE",
                "formula:2026-01-04:close:1510:600001:PULLBACK",
                "formula:2026-01-05:intraday:1400:600001:BREAKOUT",
            ]),
            "y_opportunity_r": np.asarray([1.0, 0.5, 2.0]),
            "y_opportunity_r_stress10": np.asarray([0.9, 0.4, 1.8]),
            "label_start_ms_opportunity": np.asarray([20, 10, 30]),
            "label_end_ms_opportunity": np.asarray([40, 50, 60]),
        }

        result = aggregate_stock_day_targets(
            dataset,
            ["20260102", "20260104", "20260105"],
        )

        self.assertEqual(result["dates"].tolist(), ["20260104"])
        self.assertEqual(result["codes"].tolist(), ["600001"])
        self.assertEqual(result["y_best_net_r"].tolist(), [2.0])
        self.assertAlmostEqual(
            float(result["y_best_net_r_stress10"][0]),
            1.8,
        )
        self.assertEqual(result["label_start_ms"].tolist(), [10])
        self.assertEqual(result["label_end_ms"].tolist(), [60])
        self.assertEqual(result["path_counts"].tolist(), [3])


if __name__ == "__main__":
    unittest.main()
