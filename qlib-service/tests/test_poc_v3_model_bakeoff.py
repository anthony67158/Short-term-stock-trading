import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from poc_v3_model_bakeoff import (  # noqa: E402
    active_feature_mask,
    clip_labels,
    compose_expected_net_r,
    constant_probability_metrics,
    relevance_labels,
)


class PocV3ModelBakeoffTest(unittest.TestCase):
    def test_label_clipping_uses_requested_training_quantiles(self):
        values = np.asarray([-100, -2, -1, 0, 1, 2, 100], dtype=float)

        clipped, limits = clip_labels(values, low=0.2, high=0.8)

        self.assertEqual(limits, {"lower": -1.8, "upper": 1.8})
        np.testing.assert_allclose(
            clipped,
            [-1.8, -1.8, -1, 0, 1, 1.8, 1.8],
        )

    def test_relevance_bins_are_fit_on_training_positive_returns(self):
        train = np.asarray([-2, 0, 0.2, 0.5, 1, 3, np.nan])

        labels, thresholds = relevance_labels(train)
        validation, reused = relevance_labels(
            np.asarray([-1, 0.1, 0.8, 4]),
            thresholds,
        )

        self.assertEqual(labels.tolist(), [0, 1, 2, 2, 3, 4, 1])
        self.assertEqual(validation.tolist(), [0, 2, 3, 4])
        self.assertEqual(reused, thresholds)

    def test_constant_training_features_are_excluded_for_all_models(self):
        matrix = np.asarray([
            [1, 0, 3],
            [1, 1, 3],
            [1, 2, 3],
        ], dtype=float)

        self.assertEqual(
            active_feature_mask(matrix).tolist(),
            [False, True, False],
        )

    def test_expected_net_r_combines_win_and_loss_once(self):
        values = compose_expected_net_r(
            np.asarray([0.25, 0.75]),
            np.asarray([2.0, 2.0]),
            np.asarray([-1.0, -1.0]),
        )

        np.testing.assert_allclose(values, [-0.25, 1.25])

    def test_constant_probability_baseline_uses_training_rate(self):
        metrics = constant_probability_metrics(
            np.asarray([0, 0, 1, 1]),
            np.asarray([0, 1]),
        )

        self.assertEqual(metrics["brier"], 0.25)
        self.assertEqual(metrics["positive_rate"], 0.5)


if __name__ == "__main__":
    unittest.main()
