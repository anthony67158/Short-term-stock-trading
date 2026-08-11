import importlib.util
import os
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
EVALUATOR_PATH = os.path.join(HERE, "..", "evaluate_daily_v2.py")


def load_evaluator():
    spec = importlib.util.spec_from_file_location(
        "evaluate_daily_v2",
        EVALUATOR_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TopKSelectionTest(unittest.TestCase):
    def test_selects_only_predicted_profit_rows_per_date(self):
        evaluator = load_evaluator()
        indices = evaluator.select_top_k_profit(
            dates=np.array(["d1", "d1", "d1", "d2", "d2"]),
            profit_prob=np.array([0.7, 0.9, 0.8, 0.6, 0.4]),
            predicted_class=np.array([2, 1, 2, 2, 2]),
            top_k=2,
            minimum_probability=0.5,
        )

        self.assertEqual(indices.tolist(), [2, 0, 3])

    def test_rejects_non_positive_top_k(self):
        evaluator = load_evaluator()

        with self.assertRaises(ValueError):
            evaluator.select_top_k_profit(
                dates=np.array(["d1"]),
                profit_prob=np.array([0.7]),
                predicted_class=np.array([2]),
                top_k=0,
            )


class DrawdownTest(unittest.TestCase):
    def test_computes_maximum_drawdown_from_trade_returns(self):
        evaluator = load_evaluator()

        drawdown = evaluator.maximum_drawdown(
            np.array([0.10, -0.20, 0.05])
        )

        self.assertAlmostEqual(drawdown, -0.20)

    def test_empty_returns_have_zero_drawdown(self):
        evaluator = load_evaluator()

        self.assertEqual(evaluator.maximum_drawdown(np.array([])), 0.0)


class NonOverlappingCohortTest(unittest.TestCase):
    def test_equal_weights_same_day_and_skips_overlapping_holding_periods(self):
        evaluator = load_evaluator()

        cohort_returns = evaluator.non_overlapping_cohort_returns(
            signal_dates=np.array(["d1", "d1", "d3", "d6"]),
            trade_returns=np.array([0.10, 0.00, 0.50, 0.20]),
            calendar_dates=np.array(
                ["d1", "d2", "d3", "d4", "d5", "d6", "d7"]
            ),
            holding_period=5,
        )

        self.assertEqual(cohort_returns.tolist(), [0.05, 0.20])

    def test_rejects_unknown_signal_dates(self):
        evaluator = load_evaluator()

        with self.assertRaises(ValueError):
            evaluator.non_overlapping_cohort_returns(
                signal_dates=np.array(["missing"]),
                trade_returns=np.array([0.10]),
                calendar_dates=np.array(["d1", "d2"]),
                holding_period=1,
            )


if __name__ == "__main__":
    unittest.main()
