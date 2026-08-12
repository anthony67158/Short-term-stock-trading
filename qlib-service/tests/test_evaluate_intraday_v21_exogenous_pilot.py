import importlib.util
import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODULE_PATH = os.path.join(
    SERVICE_ROOT,
    "evaluate_intraday_v21_exogenous_pilot.py",
)


def load_module():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "evaluate_intraday_v21_exogenous_pilot",
            MODULE_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(SERVICE_ROOT)


class EvaluateIntradayV21ExogenousPilotTest(unittest.TestCase):
    def test_chronological_split_purges_both_boundaries(self):
        module = load_module()
        dates = np.repeat(
            np.asarray([f"2026-01-{day:02d}" for day in range(1, 13)]),
            2,
        )

        train, calibration, test, meta = module.chronological_split(
            dates,
            calibration_dates=3,
            test_dates=3,
            purge_dates=1,
        )

        self.assertEqual(sorted(set(dates[train])), [
            "2026-01-01",
            "2026-01-02",
            "2026-01-03",
            "2026-01-04",
        ])
        self.assertEqual(sorted(set(dates[calibration])), [
            "2026-01-06",
            "2026-01-07",
            "2026-01-08",
        ])
        self.assertEqual(sorted(set(dates[test])), [
            "2026-01-10",
            "2026-01-11",
            "2026-01-12",
        ])
        self.assertEqual(meta["purged_dates"], ["2026-01-05", "2026-01-09"])

    def test_weighted_ridge_classifier_learns_independent_feature_signal(self):
        module = load_module()
        generator = np.random.default_rng(42)
        labels = np.tile(np.asarray([0, 1, 2]), 80)
        noise = generator.normal(size=(len(labels), 2))
        signal = np.eye(3, dtype=np.float64)[labels]
        features = np.concatenate((noise, signal), axis=1)

        model = module.fit_weighted_ridge_classifier(
            features,
            labels,
            l2=1.0,
        )
        probabilities = module.predict_ridge_probabilities(model, features)
        metrics = module.classification_metrics(labels, probabilities)

        self.assertGreater(metrics["balanced_accuracy"], 0.95)
        np.testing.assert_allclose(
            probabilities.sum(axis=1),
            np.ones(len(labels)),
            atol=1e-6,
        )

    def test_candidate_selection_uses_calibration_not_final_test(self):
        module = load_module()
        candidates = {
            "stock_flow": {
                "next30m": {"balanced_accuracy": 0.55},
                "sessionClose": {"balanced_accuracy": 0.56},
            },
            "market_flow": {
                "next30m": {"balanced_accuracy": 0.54},
                "sessionClose": {"balanced_accuracy": 0.58},
            },
        }

        selected = module.select_candidate(candidates)

        self.assertEqual(selected, "market_flow")


if __name__ == "__main__":
    unittest.main()
