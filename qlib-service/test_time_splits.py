import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from time_splits import (
    expanding_date_folds,
    four_way_interval_split,
    three_way_purged_split,
)


class TimeSplitTest(unittest.TestCase):
    def interval_dataset(self, count=40):
        dates = np.asarray([
            f"2026-01-{day:02d}"
            if day <= 31
            else f"2026-02-{day - 31:02d}"
            for day in range(1, count + 1)
        ])
        starts = np.arange(1, count + 1, dtype=np.int64) * 1_000
        return dates, starts, starts + 100

    def test_four_way_split_purges_real_intervals_at_every_boundary(self):
        dates, starts, ends = self.interval_dataset()
        groups = np.asarray([f"event-{index}" for index in range(len(dates))])
        ends[11] = starts[14]
        ends[20] = starts[23]
        ends[29] = starts[32]

        train, calibration, selection, confirmation, metadata = (
            four_way_interval_split(
                dates,
                starts,
                ends,
                groups,
                calibration_fraction=0.2,
                selection_fraction=0.2,
                confirmation_fraction=0.2,
                embargo_dates=1,
                minimum_partition_samples=1,
            )
        )

        self.assertNotIn(11, train)
        self.assertNotIn(20, calibration)
        self.assertNotIn(29, selection)
        self.assertTrue(np.all(ends[train] < starts[calibration].min()))
        self.assertTrue(np.all(ends[calibration] < starts[selection].min()))
        self.assertTrue(np.all(ends[selection] < starts[confirmation].min()))
        self.assertEqual(metadata["interval_purged_samples"], 3)

    def test_four_way_split_keeps_event_paths_in_one_partition(self):
        dates, starts, ends = self.interval_dataset()
        groups = np.asarray([f"event-{index}" for index in range(len(dates))])
        groups[11] = "shared-event"
        groups[13] = "shared-event"

        partitions = four_way_interval_split(
            dates,
            starts,
            ends,
            groups,
            calibration_fraction=0.2,
            selection_fraction=0.2,
            confirmation_fraction=0.2,
            embargo_dates=1,
            minimum_partition_samples=1,
        )

        for indices in partitions[:4]:
            self.assertNotIn("shared-event", set(groups[indices]))
        assigned_groups = [
            set(groups[indices])
            for indices in partitions[:4]
        ]
        for left_index, left in enumerate(assigned_groups):
            for right in assigned_groups[left_index + 1:]:
                self.assertFalse(left & right)
        self.assertEqual(partitions[4]["group_purged_samples"], 2)

    def test_four_way_split_fails_when_a_partition_is_too_small(self):
        dates, starts, ends = self.interval_dataset(count=16)
        groups = np.asarray([f"event-{index}" for index in range(len(dates))])

        with self.assertRaisesRegex(ValueError, "样本不足"):
            four_way_interval_split(
                dates,
                starts,
                ends,
                groups,
                calibration_fraction=0.15,
                selection_fraction=0.15,
                confirmation_fraction=0.15,
                embargo_dates=1,
                minimum_partition_samples=4,
            )

    def test_four_way_split_can_reserve_a_full_confirmation_year(self):
        count = 800
        dates = np.asarray([f"day-{index:04d}" for index in range(count)])
        starts = np.arange(1, count + 1, dtype=np.int64) * 1_000
        groups = np.asarray([f"event-{index}" for index in range(count)])

        _, _, _, confirmation, metadata = four_way_interval_split(
            dates,
            starts,
            starts + 100,
            groups,
            calibration_fraction=0.15,
            selection_fraction=0.15,
            confirmation_fraction=0.15,
            embargo_dates=5,
            minimum_partition_samples=1,
            minimum_confirmation_dates=252,
        )

        self.assertEqual(len(np.unique(dates[confirmation])), 252)
        self.assertEqual(metadata["minimum_confirmation_dates"], 252)

    def test_expanding_folds_keep_dates_together_and_purge_label_horizon(self):
        dates = np.repeat(
            np.asarray([f"202601{day:02d}" for day in range(1, 19)]),
            2,
        )

        folds = expanding_date_folds(
            dates,
            n_splits=3,
            purge_dates=2,
        )

        self.assertEqual(len(folds), 3)
        unique_dates = np.unique(dates)
        for train, validation in folds:
            train_dates = np.unique(dates[train])
            validation_dates = np.unique(dates[validation])
            self.assertTrue(set(train_dates).isdisjoint(validation_dates))
            validation_position = np.flatnonzero(
                unique_dates == validation_dates[0]
            )[0]
            expected_last_train = unique_dates[validation_position - 3]
            self.assertEqual(train_dates[-1], expected_last_train)

    def test_three_way_split_purges_both_boundaries(self):
        dates = np.repeat(
            np.asarray([f"202602{day:02d}" for day in range(1, 26)]),
            2,
        )

        train, calibration, holdout, metadata = three_way_purged_split(
            dates,
            calibration_fraction=0.2,
            holdout_fraction=0.2,
            purge_dates=2,
        )

        self.assertLess(
            np.unique(dates[train])[-1],
            np.unique(dates[calibration])[0],
        )
        self.assertLess(
            np.unique(dates[calibration])[-1],
            np.unique(dates[holdout])[0],
        )
        self.assertEqual(len(metadata["calibration_purge_dates"]), 2)
        self.assertEqual(len(metadata["holdout_purge_dates"]), 2)


if __name__ == "__main__":
    unittest.main()
