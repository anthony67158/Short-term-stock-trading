import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from opportunity_evaluation import (  # noqa: E402
    apply_probability_calibrator,
    binary_metrics,
    block_bootstrap_lower_bound,
    fit_probability_calibrator,
    ranking_metrics,
    regression_metrics,
    shadow_gate,
)


class OpportunityEvaluationTest(unittest.TestCase):
    def test_binary_metrics_include_calibration_and_ranking_quality(self):
        labels = np.asarray([0, 1, 0, 1, 1, 0])
        probabilities = np.asarray([0.1, 0.8, 0.3, 0.7, 0.6, 0.2])

        metrics = binary_metrics(labels, probabilities)

        self.assertLess(metrics["brier"], 0.1)
        self.assertLess(metrics["log_loss"], 0.4)
        self.assertGreater(metrics["auc"], 0.9)
        self.assertEqual(metrics["samples"], 6)
        self.assertTrue(metrics["reliability"])

    def test_ranking_metrics_are_grouped_by_signal_date(self):
        dates = np.asarray([
            "2026-09-01",
            "2026-09-01",
            "2026-09-02",
            "2026-09-02",
        ])
        relevance = np.asarray([1.0, 0.0, 0.0, 2.0])
        positive = relevance > 0
        score = np.asarray([0.9, 0.1, 0.2, 0.8])

        metrics = ranking_metrics(
            positive,
            relevance,
            score,
            dates,
            top_k=1,
        )

        self.assertEqual(metrics["precision_at_1"], 1.0)
        self.assertEqual(metrics["ndcg_at_1"], 1.0)
        self.assertEqual(metrics["mean_net_r_at_1"], 1.5)

    def test_regression_metrics_and_daily_bootstrap_are_deterministic(self):
        actual = np.asarray([-1.0, 0.0, 1.0, 2.0])
        predicted = np.asarray([-0.8, 0.1, 0.8, 1.7])
        metrics = regression_metrics(actual, predicted)

        self.assertAlmostEqual(metrics["mae"], 0.2)
        self.assertAlmostEqual(metrics["rmse"], 0.212132, places=6)
        self.assertGreater(metrics["rank_correlation"], 0.99)

        lower_a = block_bootstrap_lower_bound(
            {
                "2026-09-01": 0.2,
                "2026-09-02": -0.1,
                "2026-09-03": 0.4,
            },
            samples=200,
            random_state=7,
        )
        lower_b = block_bootstrap_lower_bound(
            {
                "2026-09-01": 0.2,
                "2026-09-02": -0.1,
                "2026-09-03": 0.4,
            },
            samples=200,
            random_state=7,
        )
        self.assertEqual(lower_a, lower_b)

    def test_probability_calibration_uses_sigmoid_for_small_samples(self):
        labels = np.asarray([0, 0, 1, 1])
        probabilities = np.asarray([0.1, 0.4, 0.6, 0.9])
        artifact = fit_probability_calibrator(
            labels,
            probabilities,
            isotonic_minimum=1000,
        )
        adjusted = apply_probability_calibrator(
            probabilities,
            artifact,
        )

        self.assertEqual(artifact["method"], "sigmoid")
        self.assertTrue(np.all(adjusted >= 0))
        self.assertTrue(np.all(adjusted <= 1))
        self.assertLess(adjusted[0], adjusted[-1])

    def test_probability_calibration_supports_serialized_isotonic_curve(self):
        artifact = {
            "method": "isotonic",
            "x": [0.1, 0.5, 0.9],
            "y": [0.0, 0.6, 1.0],
        }

        adjusted = apply_probability_calibrator(
            np.asarray([0.0, 0.3, 1.0]),
            artifact,
        )

        np.testing.assert_allclose(adjusted, [0.0, 0.3, 1.0])

    def test_shadow_gate_requires_all_heads_to_match_simple_baselines(self):
        accepted = shadow_gate({
            "pFill": {
                "challenger": {"brier": 0.19, "log_loss": 0.55},
                "baseline": {"brier": 0.20, "log_loss": 0.56},
            },
            "pWinGivenFill": {
                "challenger": {"brier": 0.21, "log_loss": 0.60},
                "baseline": {"brier": 0.20, "log_loss": 0.59},
            },
            "expectedNetR": {
                "challenger": {"mae": 0.50},
                "baseline": {"mae": 0.50},
            },
        })
        rejected = shadow_gate({
            **accepted["metrics"],
            "expectedNetR": {
                "challenger": {"mae": 0.60},
                "baseline": {"mae": 0.50},
            },
        })

        self.assertTrue(accepted["shadowEligible"])
        self.assertFalse(accepted["productionEligible"])
        self.assertFalse(rejected["shadowEligible"])
        self.assertTrue(rejected["shadowBlockers"])


if __name__ == "__main__":
    unittest.main()
