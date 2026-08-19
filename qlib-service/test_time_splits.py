import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from time_splits import expanding_date_folds, three_way_purged_split


class TimeSplitTest(unittest.TestCase):
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
