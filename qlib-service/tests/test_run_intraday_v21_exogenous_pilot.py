import importlib.util
import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODULE_PATH = os.path.join(
    SERVICE_ROOT,
    "run_intraday_v21_exogenous_pilot.py",
)


def load_module():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "run_intraday_v21_exogenous_pilot",
            MODULE_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(SERVICE_ROOT)


class RunIntradayV21ExogenousPilotTest(unittest.TestCase):
    def test_exogenous_columns_are_inserted_before_stock_category(self):
        module = load_module()
        base = np.asarray([
            [1.0, 2.0, 7.0],
            [3.0, 4.0, 8.0],
        ], dtype=np.float32)
        exogenous = np.asarray([
            [10.0, 11.0],
            [12.0, 13.0],
        ], dtype=np.float32)

        result = module.append_exogenous_features(base, exogenous)

        np.testing.assert_allclose(result, [
            [1.0, 2.0, 10.0, 11.0, 7.0],
            [3.0, 4.0, 12.0, 13.0, 8.0],
        ])

    def test_pilot_only_recommends_expansion_when_both_heads_improve(self):
        module = load_module()
        baseline = {
            "next30m": {"balanced_accuracy": 0.53},
            "sessionClose": {"balanced_accuracy": 0.54},
        }
        promising = {
            "next30m": {"balanced_accuracy": 0.545},
            "sessionClose": {"balanced_accuracy": 0.552},
        }
        mixed = {
            "next30m": {"balanced_accuracy": 0.55},
            "sessionClose": {"balanced_accuracy": 0.538},
        }

        accepted = module.pilot_verdict(baseline, promising)
        rejected = module.pilot_verdict(baseline, mixed)

        self.assertEqual(accepted["decision"], "expand_research")
        self.assertGreater(accepted["mean_improvement"], 0.01)
        self.assertEqual(rejected["decision"], "reject")
        self.assertIn("双头没有同时改善", rejected["reason"])


if __name__ == "__main__":
    unittest.main()
