import os
import sys
import unittest

import numpy as np


SERVICE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from train_36_max import (
    daily_top_k_precision,
    date_grouped_indices,
    return_relevance_labels,
    three_way_purged_split,
)
from train_36_return_rank import top_k_return_metrics


class Train36MaxSplitTest(unittest.TestCase):
    def test_purges_both_calibration_boundaries_by_unique_date(self):
        dates = np.repeat(
            np.asarray([f"202601{day:02d}" for day in range(1, 21)]),
            2,
        )

        train, calibration, holdout, metadata = three_way_purged_split(
            dates,
            calibration_fraction=0.2,
            holdout_fraction=0.2,
            purge_dates=2,
        )

        self.assertEqual(sorted(set(dates[train])), [
            "20260101",
            "20260102",
            "20260103",
            "20260104",
            "20260105",
            "20260106",
            "20260107",
            "20260108",
        ])
        self.assertEqual(sorted(set(dates[calibration])), [
            "20260111",
            "20260112",
            "20260113",
            "20260114",
        ])
        self.assertEqual(sorted(set(dates[holdout])), [
            "20260117",
            "20260118",
            "20260119",
            "20260120",
        ])
        self.assertEqual(metadata["calibration_purge_dates"], [
            "20260109",
            "20260110",
        ])
        self.assertEqual(metadata["holdout_purge_dates"], [
            "20260115",
            "20260116",
        ])

    def test_groups_ranker_rows_by_date_without_losing_indices(self):
        dates = np.asarray(["20260102", "20260101", "20260102", "20260103"])
        indices = np.asarray([3, 0, 2, 1])

        ordered, groups = date_grouped_indices(dates, indices)

        self.assertEqual(ordered.tolist(), [1, 0, 2, 3])
        self.assertEqual(groups, [1, 2, 1])
        self.assertEqual(sorted(ordered.tolist()), sorted(indices.tolist()))

    def test_daily_top_k_precision_only_scores_each_dates_leaders(self):
        dates = np.asarray(
            ["20260101"] * 4 + ["20260102"] * 4,
        )
        labels = np.asarray([1, 0, 1, 0, 0, 1, 0, 1])
        scores = np.asarray([0.9, 0.8, 0.2, 0.1, 0.9, 0.8, 0.2, 0.1])

        metrics = daily_top_k_precision(dates, labels, scores, top_k=2)

        self.assertEqual(metrics["selected"], 4)
        self.assertEqual(metrics["dates"], 2)
        self.assertAlmostEqual(metrics["precision"], 0.5)
        self.assertAlmostEqual(metrics["base_rate"], 0.5)
        self.assertAlmostEqual(metrics["lift"], 1.0)

    def test_return_relevance_labels_are_quantiled_within_each_date(self):
        dates = np.asarray(["20260101"] * 5 + ["20260102"] * 5)
        returns = np.asarray(
            [-0.05, -0.02, 0.0, 0.02, 0.08, 0.5, 0.6, 0.7, 0.8, 0.9],
        )

        labels = return_relevance_labels(dates, returns, levels=5)

        self.assertEqual(labels.tolist(), [0, 1, 2, 3, 4] * 2)

    def test_top_k_return_metrics_use_each_dates_highest_scores(self):
        dates = np.asarray(["20260101"] * 3 + ["20260102"] * 3)
        returns = np.asarray([0.01, 0.03, -0.02, 0.02, -0.01, 0.04])
        scores = np.asarray([0.1, 0.9, 0.2, 0.8, 0.1, 0.9])

        metrics = top_k_return_metrics(
            dates,
            returns,
            scores,
            top_k=1,
        )

        self.assertEqual(metrics["signals"], 2)
        self.assertEqual(metrics["dates"], 2)
        self.assertAlmostEqual(metrics["mean_return"], 0.035)
        self.assertAlmostEqual(metrics["win_rate"], 1.0)


if __name__ == "__main__":
    unittest.main()
