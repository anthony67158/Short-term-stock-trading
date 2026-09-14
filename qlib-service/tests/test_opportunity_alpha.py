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
    momentum_by_code,
    percentile_by_date,
    rolling_mature_rank_ic,
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
            "y_fill_opportunity": np.asarray([1, 0, 1]),
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
        self.assertEqual(result["filled_path_counts"].tolist(), [2])

    def test_no_trade_floor_beats_only_losing_filled_paths(self):
        dataset = {
            "X_opportunity": np.zeros((2, 1)),
            "dates_opportunity": np.asarray([
                "2026-01-05",
                "2026-01-05",
            ]),
            "codes_opportunity": np.asarray(["600001", "600001"]),
            "decision_ids_opportunity": np.asarray([
                "formula:2026-01-05:close:1510:600001:IMMEDIATE",
                "formula:2026-01-05:close:1510:600001:PULLBACK",
            ]),
            "y_opportunity_r": np.asarray([-1.0, 0.0]),
            "y_opportunity_r_stress10": np.asarray([-1.1, 0.0]),
            "y_fill_opportunity": np.asarray([1, 0]),
            "label_start_ms_opportunity": np.asarray([10, 20]),
            "label_end_ms_opportunity": np.asarray([30, 40]),
        }

        result = aggregate_stock_day_targets(
            dataset,
            ["20260105"],
        )

        self.assertEqual(result["y_best_net_r"].tolist(), [0.0])
        self.assertEqual(result["filled_path_counts"].tolist(), [1])

    def test_percentile_and_momentum_are_cross_sectional_and_per_stock(self):
        dates = np.asarray(["d1", "d1", "d2", "d2"])
        codes = np.asarray(["A", "B", "A", "B"])
        percentile = percentile_by_date(
            np.asarray([1.0, 3.0, 4.0, 2.0]),
            dates,
        )

        np.testing.assert_allclose(percentile, [0.0, 1.0, 1.0, 0.0])
        np.testing.assert_allclose(
            momentum_by_code(percentile, codes, dates, lag=1),
            [0.0, 0.0, 1.0, -1.0],
        )

    def test_rolling_rank_ic_only_uses_mature_prior_dates(self):
        dates = np.asarray(
            ["20260102"] * 6
            + ["20260105"] * 6
            + ["20260106"] * 6
        )
        scores = np.tile(np.arange(6, dtype=float), 3)
        targets = np.tile(np.arange(6, dtype=float), 3)
        day_ms = 24 * 60 * 60 * 1000
        first_end = 1_767_290_400_000
        ends = np.asarray(
            [first_end] * 6
            + [first_end + 3 * day_ms] * 6
            + [first_end + 4 * day_ms] * 6,
        )

        result = rolling_mature_rank_ic(
            scores,
            targets,
            dates,
            ends,
            ["20260102", "20260105", "20260106"],
            window=20,
        )

        self.assertEqual(result["20260102"], 0.0)
        self.assertEqual(result["20260105"], 1.0)
        self.assertEqual(result["20260106"], 1.0)


if __name__ == "__main__":
    unittest.main()
