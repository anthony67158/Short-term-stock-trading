import importlib.util
import os
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
MODULE_PATH = os.path.join(HERE, "..", "train_intraday_tcn.py")


def load_trainer():
    spec = importlib.util.spec_from_file_location(
        "train_intraday_tcn",
        MODULE_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class IntradayTcnSplitTest(unittest.TestCase):
    def test_purges_label_overlap_before_the_time_holdout(self):
        trainer = load_trainer()
        dates = np.array(
            [
                "20260701",
                "20260701",
                "20260702",
                "20260702",
                "20260703",
                "20260703",
                "20260704",
                "20260704",
                "20260705",
                "20260705",
            ]
        )

        train_index, holdout_index, metadata = trainer.purged_holdout_split(
            dates,
            holdout_fraction=0.2,
            purge_dates=1,
        )

        self.assertEqual(metadata["holdout_start_date"], "20260705")
        self.assertEqual(metadata["purge_start_date"], "20260704")
        self.assertEqual(np.unique(dates[train_index]).tolist(), ["20260701", "20260702", "20260703"])
        self.assertEqual(np.unique(dates[holdout_index]).tolist(), ["20260705"])


class IntradayTcnNormalizationTest(unittest.TestCase):
    def test_normalizes_with_train_rows_only(self):
        trainer = load_trainer()
        train = np.array(
            [
                [[1.0, 10.0], [3.0, 14.0]],
                [[5.0, 18.0], [7.0, 22.0]],
            ],
            dtype=np.float32,
        )
        holdout = np.array([[[100.0, -20.0]]], dtype=np.float32)

        mean, std = trainer.fit_normalizer(train)
        normalized_holdout = trainer.apply_normalizer(holdout, mean, std)

        self.assertEqual(mean.tolist(), [4.0, 16.0])
        self.assertEqual(std.tolist(), [np.sqrt(5.0), np.sqrt(20.0)])
        self.assertGreater(normalized_holdout[0, 0, 0], 40.0)
        self.assertLess(normalized_holdout[0, 0, 1], -7.0)

    def test_maps_barrier_labels_to_the_three_classifier_classes(self):
        trainer = load_trainer()

        self.assertEqual(
            trainer.map_barrier_labels(np.array([-1, 0, 1])).tolist(),
            [0, 1, 2],
        )

        with self.assertRaises(ValueError):
            trainer.map_barrier_labels(np.array([2]))


class ArchitectureSelectionTest(unittest.TestCase):
    def test_accepts_the_three_planned_sequence_architectures(self):
        trainer = load_trainer()

        self.assertEqual(trainer.normalize_architecture("tcn"), "tcn")
        self.assertEqual(trainer.normalize_architecture("gru"), "gru")
        self.assertEqual(
            trainer.normalize_architecture("transformer"),
            "transformer",
        )

    def test_rejects_an_unknown_sequence_architecture(self):
        trainer = load_trainer()

        with self.assertRaises(ValueError):
            trainer.normalize_architecture("lstm")


if __name__ == "__main__":
    unittest.main()
