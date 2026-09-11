import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from decision_engine.training.evaluation import (  # noqa: E402
    apply_probability_calibrator,
    binary_metrics,
    block_bootstrap_lower_bound,
    fit_probability_calibrator,
    fit_stratified_probability_calibrator,
    probability_calibration_bucket,
    ranking_metrics,
    regression_metrics,
    select_risk_adjusted_trial,
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
        self.assertEqual(metrics["accuracy"], 1.0)
        self.assertEqual(metrics["precision"], 1.0)
        self.assertEqual(metrics["recall"], 1.0)
        self.assertEqual(metrics["f1"], 1.0)
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

    def test_ranking_metrics_keep_one_route_per_stock(self):
        dates = np.asarray([
            "2026-09-01",
            "2026-09-01",
            "2026-09-01",
        ])
        codes = np.asarray(["600001", "600001", "600002"])
        relevance = np.asarray([1.0, 0.8, 0.4])
        score = np.asarray([0.9, 0.85, 0.7])

        metrics = ranking_metrics(
            relevance > 0,
            relevance,
            score,
            dates,
            top_k=2,
            group_ids=codes,
        )

        self.assertEqual(metrics["precision_at_2"], 1.0)
        self.assertEqual(metrics["mean_net_r_at_2"], 0.7)

    def test_ranking_metrics_do_not_force_ineligible_candidates_into_top_k(self):
        dates = np.asarray([
            "2026-09-01",
            "2026-09-01",
            "2026-09-02",
            "2026-09-02",
        ])
        relevance = np.asarray([1.0, -2.0, -1.0, -3.0])
        eligible = np.asarray([True, False, False, False])

        metrics = ranking_metrics(
            relevance > 0,
            relevance,
            np.asarray([0.9, 0.8, 0.7, 0.6]),
            dates,
            top_k=5,
            eligible_mask=eligible,
        )

        self.assertEqual(metrics["selected"], 1)
        self.assertEqual(metrics["active_days"], 1)
        self.assertEqual(metrics["daily_net_r"]["2026-09-01"], 1.0)
        self.assertEqual(metrics["daily_net_r"]["2026-09-02"], 0.0)
        self.assertEqual(metrics["mean_net_r_at_5"], 0.5)

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

    def test_blend_selection_prefers_downside_protection_over_peak_mean(self):
        selected = select_risk_adjusted_trial([
            {
                "weight": 0.0,
                "meanNetRAt5": 0.5,
                "netRLowerBound": -0.2,
                "maxDrawdownRAt5": 2.0,
                "positiveExpectedCoverage": 0.1,
            },
            {
                "weight": 0.5,
                "meanNetRAt5": 0.3,
                "netRLowerBound": 0.1,
                "maxDrawdownRAt5": 1.0,
                "positiveExpectedCoverage": 0.08,
            },
        ])

        self.assertEqual(selected["weight"], 0.5)

    def test_blend_selection_keeps_minimum_coverage(self):
        selected = select_risk_adjusted_trial(
            [
                {
                    "weight": 0.0,
                    "meanNetRAt5": 0.8,
                    "netRLowerBound": 0.4,
                    "maxDrawdownRAt5": 0.5,
                    "positiveExpectedCoverage": 0.01,
                },
                {
                    "weight": 0.25,
                    "meanNetRAt5": 0.2,
                    "netRLowerBound": 0.05,
                    "maxDrawdownRAt5": 1.0,
                    "positiveExpectedCoverage": 0.03,
                },
            ],
        )

        self.assertEqual(selected["weight"], 0.25)

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

    def test_probability_calibration_stays_finite_when_nearly_separable(self):
        labels = np.asarray([0] * 20 + [1] * 20)
        probabilities = np.asarray([0.01] * 20 + [0.99] * 20)
        artifact = fit_probability_calibrator(
            labels,
            probabilities,
            isotonic_minimum=1000,
        )
        adjusted = apply_probability_calibrator(
            probabilities,
            artifact,
        )

        self.assertTrue(np.isfinite(adjusted).all())
        self.assertGreater(adjusted[-1], adjusted[0])

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

    def test_stratified_probability_calibration_uses_specific_groups(self):
        probabilities = np.full(16, 0.5)
        playbooks = np.asarray(["A"] * 8 + ["B"] * 8)
        routes = np.asarray(["PULLBACK"] * 16)
        labels = np.asarray(
            [0, 0, 0, 0, 0, 0, 1, 1]
            + [0, 0, 1, 1, 1, 1, 1, 1],
        )
        artifact = fit_stratified_probability_calibrator(
            labels,
            probabilities,
            playbooks,
            routes,
            minimum_samples=4,
            minimum_class_samples=1,
            shrinkage_samples=0,
            isotonic_minimum=1000,
        )
        adjusted = apply_probability_calibrator(
            np.asarray([0.5, 0.5, 0.5]),
            artifact,
            playbook_ids=np.asarray(["A", "B", "UNKNOWN"]),
            routes=np.asarray(["PULLBACK"] * 3),
        )

        self.assertEqual(
            artifact["method"],
            "stratified-playbook-route",
        )
        self.assertLess(adjusted[0], 0.5)
        self.assertGreater(adjusted[1], 0.5)
        self.assertAlmostEqual(adjusted[2], 0.5)
        self.assertEqual(
            probability_calibration_bucket(
                artifact,
                "A",
                "PULLBACK",
            )["level"],
            "playbookRoute",
        )
        self.assertEqual(
            probability_calibration_bucket(
                artifact,
                "UNKNOWN",
                "PULLBACK",
            )["level"],
            "route",
        )

    def test_stratified_probability_calibration_rejects_bad_dimensions(self):
        with self.assertRaisesRegex(ValueError, "打法校准分层维度无效"):
            fit_stratified_probability_calibrator(
                np.asarray([0, 1]),
                np.asarray([0.2, 0.8]),
                np.asarray(["A"]),
                np.asarray(["IMMEDIATE", "IMMEDIATE"]),
            )

    def test_stratified_calibration_rejects_unstable_time_bucket(self):
        dates = np.repeat(
            np.asarray([f"2026-01-{day:02d}" for day in range(1, 9)]),
            10,
        )
        playbooks = np.tile(
            np.asarray(["A"] * 5 + ["B"] * 5),
            8,
        )
        routes = np.asarray(["IMMEDIATE"] * 80)
        labels = []
        for day in range(8):
            labels.extend(
                [0, 0, 0, 0, 1, 0, 1, 1, 1, 1]
                if day < 5
                else [0, 1, 1, 1, 1, 0, 0, 0, 0, 1]
            )
        artifact = fit_stratified_probability_calibrator(
            np.asarray(labels),
            np.full(80, 0.5),
            playbooks,
            routes,
            dates=dates,
            minimum_samples=20,
            minimum_class_samples=5,
            minimum_validation_samples=10,
            minimum_validation_class_samples=2,
            minimum_brier_lift=0,
        )

        self.assertFalse(artifact["groups"]["playbookRoute"])
        self.assertFalse(artifact["groups"]["playbook"])

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
            "ranking": {
                "challenger": {
                    "ndcg_at_5": 0.6,
                    "precision_at_5": 0.6,
                    "mean_net_r_at_5": 0.2,
                },
                "baseline": {
                    "ndcg_at_5": 0.59,
                    "precision_at_5": 0.59,
                    "mean_net_r_at_5": 0.19,
                },
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
