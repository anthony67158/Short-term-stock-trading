import importlib.util
import os
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
TRAINER_PATH = os.path.join(HERE, "..", "train_daily_v2.py")


def load_trainer():
    spec = importlib.util.spec_from_file_location(
        "train_daily_v2",
        TRAINER_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PurgedHoldoutTest(unittest.TestCase):
    def test_splits_by_unique_date_and_purges_overlapping_label_dates(self):
        trainer = load_trainer()
        unique_dates = np.array([f"202601{i:02d}" for i in range(1, 21)])
        dates = np.repeat(unique_dates, 2)

        train_index, holdout_index, metadata = trainer.purged_holdout_split(
            dates,
            holdout_fraction=0.15,
            purge_dates=5,
        )

        self.assertEqual(metadata["holdout_start_date"], "20260118")
        self.assertEqual(metadata["purge_start_date"], "20260113")
        self.assertEqual(sorted(dates[train_index])[-1], "20260112")
        self.assertEqual(sorted(dates[holdout_index])[0], "20260118")
        self.assertEqual(len(holdout_index), 6)

    def test_rejects_a_dataset_too_short_for_the_purge(self):
        trainer = load_trainer()

        with self.assertRaises(ValueError):
            trainer.purged_holdout_split(
                np.array(["d1", "d2", "d3", "d4"]),
                holdout_fraction=0.25,
                purge_dates=3,
            )


class BarrierClassMappingTest(unittest.TestCase):
    def test_maps_loss_timeout_profit_to_lightgbm_classes(self):
        trainer = load_trainer()

        mapped = trainer.map_barrier_labels(np.array([-1, 0, 1, -1]))

        self.assertEqual(mapped.tolist(), [0, 1, 2, 0])

    def test_rejects_unknown_barrier_labels(self):
        trainer = load_trainer()

        with self.assertRaises(ValueError):
            trainer.map_barrier_labels(np.array([-1, 0, 2]))


if __name__ == "__main__":
    unittest.main()
