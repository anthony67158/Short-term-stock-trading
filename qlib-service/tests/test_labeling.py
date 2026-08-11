import importlib.util
import os
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
LABELING_PATH = os.path.join(HERE, "..", "labeling.py")


def load_labeling():
    spec = importlib.util.spec_from_file_location("labeling", LABELING_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TripleBarrierLabelTest(unittest.TestCase):
    def setUp(self):
        self.labeling = load_labeling()

    def test_labels_profit_when_the_upper_barrier_is_reached_first(self):
        outcome = self.labeling.triple_barrier_outcome(
            entry_price=10.0,
            future_high=np.array([10.1, 10.6, 10.2]),
            future_low=np.array([9.9, 9.8, 9.7]),
            take_profit_pct=0.05,
            stop_loss_pct=0.04,
        )

        self.assertEqual(outcome, self.labeling.PROFIT)

    def test_labels_loss_when_the_lower_barrier_is_reached_first(self):
        outcome = self.labeling.triple_barrier_outcome(
            entry_price=10.0,
            future_high=np.array([10.1, 10.6, 10.7]),
            future_low=np.array([9.5, 9.8, 9.9]),
            take_profit_pct=0.05,
            stop_loss_pct=0.04,
        )

        self.assertEqual(outcome, self.labeling.LOSS)

    def test_labels_timeout_when_neither_barrier_is_reached(self):
        outcome = self.labeling.triple_barrier_outcome(
            entry_price=10.0,
            future_high=np.array([10.1, 10.2, 10.3]),
            future_low=np.array([9.9, 9.8, 9.7]),
            take_profit_pct=0.05,
            stop_loss_pct=0.04,
        )

        self.assertEqual(outcome, self.labeling.TIMEOUT)

    def test_same_bar_collision_uses_the_conservative_loss_policy(self):
        outcome = self.labeling.triple_barrier_outcome(
            entry_price=10.0,
            future_high=np.array([10.6]),
            future_low=np.array([9.5]),
            take_profit_pct=0.05,
            stop_loss_pct=0.04,
        )

        self.assertEqual(outcome, self.labeling.LOSS)


class ForwardPathLabelTest(unittest.TestCase):
    def setUp(self):
        self.labeling = load_labeling()

    def test_computes_return_mfe_and_mae_for_each_horizon(self):
        labels = self.labeling.forward_path_labels(
            close=np.array([10.0, 10.5, 10.2, 11.0]),
            high=np.array([10.1, 10.8, 10.7, 11.3]),
            low=np.array([9.9, 9.8, 9.7, 10.4]),
            index=0,
            horizons=(1, 3),
        )

        self.assertAlmostEqual(labels["return_1d"], 0.05)
        self.assertAlmostEqual(labels["mfe_1d"], 0.08)
        self.assertAlmostEqual(labels["mae_1d"], -0.02)
        self.assertAlmostEqual(labels["return_3d"], 0.10)
        self.assertAlmostEqual(labels["mfe_3d"], 0.13)
        self.assertAlmostEqual(labels["mae_3d"], -0.03)

    def test_rejects_a_row_without_the_full_forward_horizon(self):
        with self.assertRaises(ValueError):
            self.labeling.forward_path_labels(
                close=np.array([10.0, 10.5, 10.2]),
                high=np.array([10.1, 10.8, 10.7]),
                low=np.array([9.9, 9.8, 9.7]),
                index=1,
                horizons=(3,),
            )

    def test_values_after_the_horizon_cannot_change_the_label(self):
        close = np.array([10.0, 10.2, 10.3, 50.0])
        high = np.array([10.1, 10.4, 10.5, 60.0])
        low = np.array([9.9, 9.8, 9.7, 1.0])

        labels = self.labeling.forward_path_labels(
            close=close,
            high=high,
            low=low,
            index=0,
            horizons=(2,),
        )

        self.assertAlmostEqual(labels["return_2d"], 0.03)
        self.assertAlmostEqual(labels["mfe_2d"], 0.05)
        self.assertAlmostEqual(labels["mae_2d"], -0.03)


if __name__ == "__main__":
    unittest.main()
