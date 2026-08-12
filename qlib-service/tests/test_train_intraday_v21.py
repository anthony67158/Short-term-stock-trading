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

    def test_batches_large_holdout_evaluation_without_gaps(self):
        trainer = load_trainer()

        batches = list(trainer.evaluation_slices(1_000_003, 4096))

        self.assertEqual(batches[0], slice(0, 4096))
        self.assertEqual(batches[-1].stop, 1_000_003)
        self.assertTrue(all(
            current.start == previous.stop
            for previous, current in zip(batches, batches[1:])
        ))
        self.assertLessEqual(
            max(current.stop - current.start for current in batches),
            4096,
        )

    def test_chunked_normalizer_matches_direct_training_subset_statistics(self):
        trainer = load_trainer()
        values = np.arange(8 * 4 * 3, dtype=np.float32).reshape(8, 4, 3)
        train_index = np.asarray([0, 1, 3, 4, 6])

        mean, std = trainer.fit_indexed_normalizer(
            values,
            train_index,
            chunk_size=2,
        )

        expected = values[train_index].astype(np.float64)
        np.testing.assert_allclose(mean, expected.mean(axis=(0, 1)))
        np.testing.assert_allclose(std, expected.std(axis=(0, 1)))

    def test_three_way_date_split_keeps_calibration_before_holdout(self):
        trainer = load_trainer()
        dates = np.repeat(
            np.asarray([f"202608{day:02d}" for day in range(1, 21)]),
            2,
        )

        train, calibration, holdout, metadata = (
            trainer.three_way_date_split(
                dates,
                holdout_fraction=0.2,
                calibration_fraction=0.2,
                purge_dates=1,
            )
        )

        train_dates = sorted(set(dates[train]))
        calibration_dates = sorted(set(dates[calibration]))
        holdout_dates = sorted(set(dates[holdout]))
        self.assertLess(train_dates[-1], calibration_dates[0])
        self.assertLess(calibration_dates[-1], holdout_dates[0])
        self.assertEqual(metadata["holdout_samples"], len(holdout))
        self.assertEqual(metadata["calibration_samples"], len(calibration))

    def test_session_calibration_improves_balanced_accuracy_without_holdout(self):
        trainer = load_trainer()
        labels = np.repeat(np.asarray([0, 1, 2]), 30)
        probabilities = np.vstack([
            np.tile([0.45, 0.30, 0.25], (30, 1)),
            np.tile([0.40, 0.35, 0.25], (30, 1)),
            np.tile([0.40, 0.25, 0.35], (30, 1)),
        ])
        buckets = np.full(len(labels), "morning")

        calibration = trainer.fit_probability_calibration(
            labels,
            probabilities,
            buckets,
        )
        adjusted = trainer.apply_probability_calibration(
            probabilities,
            buckets,
            calibration,
        )

        before = trainer.balanced_accuracy(
            labels,
            probabilities.argmax(axis=1),
        )
        after = trainer.balanced_accuracy(
            labels,
            adjusted.argmax(axis=1),
        )
        self.assertGreater(after, before)
        np.testing.assert_allclose(adjusted.sum(axis=1), 1.0)

    def test_stable_calibration_is_refit_only_after_forward_validation(self):
        trainer = load_trainer()
        labels = np.tile(np.repeat(np.asarray([0, 1, 2]), 10), 4)
        probabilities = np.tile(np.vstack([
            np.tile([0.45, 0.30, 0.25], (10, 1)),
            np.tile([0.40, 0.35, 0.25], (10, 1)),
            np.tile([0.40, 0.25, 0.35], (10, 1)),
        ]), (4, 1))
        buckets = np.full(len(labels), "morning")
        dates = np.repeat(
            np.asarray(["20260101", "20260102", "20260103", "20260104"]),
            30,
        )

        calibration = trainer.select_stable_probability_calibration(
            labels,
            probabilities,
            buckets,
            dates,
        )

        self.assertNotEqual(calibration["morning"], [0.0, 0.0, 0.0])
        self.assertEqual(calibration["noon"], [0.0, 0.0, 0.0])

    def test_pooled_transformer_configuration_is_checkpointed(self):
        trainer = load_trainer()

        self.assertEqual(
            trainer.ARCHITECTURE,
            "transformer-dual-head-pooled",
        )
        self.assertEqual(trainer.MODEL_CONFIG["pooling"], "last-mean-max")
        self.assertEqual(trainer.MODEL_CONFIG["num_layers"], 3)


if __name__ == "__main__":
    unittest.main()
