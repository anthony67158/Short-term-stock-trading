import unittest

import numpy as np

from build_dataset import make_samples


class DatasetForecastBacktestTest(unittest.TestCase):
    def test_only_post_cutoff_samples_replay_the_production_next_day_forecast(self):
        opens = np.array([1, 2, 3, 4, 5, 6], dtype=float)
        closes = np.array([1, 2, 3, 4, 5, 6], dtype=float)
        highs = closes + 0.2
        lows = closes - 0.2
        volumes = np.array([100, 110, 120, 130, 140, 150], dtype=float)
        dates = [
            "2026-08-05",
            "2026-08-06",
            "2026-08-07",
            "2026-08-10",
            "2026-08-11",
            "2026-08-12",
        ]
        calls = []

        def forecast_impl(factors, days):
            calls.append((factors["_last"], days))
            return {
                "upProb": 60,
                "targetLow": 2,
                "targetHigh": 4,
            }

        (
            features,
            labels,
            sample_dates,
            next_probabilities,
            next_actual_up,
            next_range_hit,
        ) = make_samples(
            opens,
            closes,
            highs,
            lows,
            volumes,
            dates,
            horizon=2,
            min_hist=2,
            forecast_after="2026-08-07",
            forecast_impl=forecast_impl,
        )

        self.assertEqual(len(features), 2)
        self.assertEqual(len(labels), 2)
        self.assertEqual(sample_dates, ["2026-08-07", "2026-08-10"])
        self.assertTrue(np.isnan(next_probabilities[0]))
        self.assertEqual(next_actual_up[0], -1)
        self.assertEqual(next_range_hit[0], -1)
        self.assertEqual(next_probabilities[1], 0.6)
        self.assertEqual(next_actual_up[1], 1)
        self.assertEqual(next_range_hit[1], 0)
        self.assertEqual(calls, [(4.0, 1)])


if __name__ == "__main__":
    unittest.main()
