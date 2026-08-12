import importlib.util
import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
MODULE_PATH = os.path.join(HERE, "..", "train_intraday_v21.py")


def load_trainer():
    sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..")))
    try:
        spec = importlib.util.spec_from_file_location(
            "train_intraday_v21",
            MODULE_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


class IntradayV21TrainerContractTest(unittest.TestCase):
    def test_validates_two_independent_three_class_heads(self):
        trainer = load_trainer()
        result = trainer.validate_dual_head_dataset(
            np.zeros((3, 60, 6), dtype=np.float32),
            np.asarray([-1, 0, 1]),
            np.asarray([1, 0, -1]),
            np.asarray(["morning", "noon", "afternoon"]),
        )

        self.assertEqual(result["samples"], 3)
        self.assertEqual(result["sequence_length"], 60)
        self.assertEqual(result["features"], 6)

    def test_rejects_mismatched_or_unknown_head_labels(self):
        trainer = load_trainer()
        with self.assertRaisesRegex(ValueError, "长度"):
            trainer.validate_dual_head_dataset(
                np.zeros((2, 60, 6), dtype=np.float32),
                np.asarray([0]),
                np.asarray([0, 1]),
                np.asarray(["morning", "noon"]),
            )
        with self.assertRaisesRegex(ValueError, "三重障碍"):
            trainer.validate_dual_head_dataset(
                np.zeros((2, 60, 6), dtype=np.float32),
                np.asarray([0, 2]),
                np.asarray([0, 1]),
                np.asarray(["morning", "noon"]),
            )

    def test_uses_date_purged_holdout_for_overlapping_intraday_samples(self):
        trainer = load_trainer()
        dates = np.asarray([
            "20260801",
            "20260801",
            "20260802",
            "20260802",
            "20260803",
            "20260803",
            "20260804",
            "20260804",
            "20260805",
            "20260805",
        ])

        train, holdout, metadata = trainer.purged_holdout_split(
            dates,
            holdout_fraction=0.2,
            purge_dates=1,
        )

        self.assertEqual(np.unique(dates[train]).tolist(), [
            "20260801",
            "20260802",
            "20260803",
        ])
        self.assertEqual(np.unique(dates[holdout]).tolist(), ["20260805"])
        self.assertEqual(metadata["purge_start_date"], "20260804")


if __name__ == "__main__":
    unittest.main()
