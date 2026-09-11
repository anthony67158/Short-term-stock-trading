import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from decision_engine.contracts import FEATURE_NAMES  # noqa: E402
from decision_engine.training.backtest_dataset import (  # noqa: E402
    interval_expanding_folds,
    normalize_poc_outcome,
    slot_minutes,
)


class DecisionBacktestDatasetTest(unittest.TestCase):
    def test_hhmm_slots_match_live_minute_buckets(self):
        self.assertEqual(slot_minutes("1020"), 620)
        self.assertEqual(slot_minutes("1340"), 820)
        self.assertEqual(slot_minutes(820), 820)

        value = {
            "mode": "INTRADAY",
            "slot": "1340",
            "fillStatus": "NOT_TRIGGERED",
            "scoreInput": {
                "dimensions": {"timeBucket": "INTRADAY_CLOSE"},
                "factors": {
                    **{name: 0.0 for name in FEATURE_NAMES},
                    "time_INTRADAY_CLOSE": 1.0,
                },
            },
        }
        normalized = normalize_poc_outcome(value)
        self.assertEqual(
            normalized["scoreInput"]["dimensions"]["timeBucket"],
            "INTRADAY_AFTERNOON",
        )
        self.assertEqual(
            normalized["scoreInput"]["factors"][
                "time_INTRADAY_AFTERNOON"
            ],
            1.0,
        )
        self.assertEqual(
            normalized["scoreInput"]["factors"]["time_INTRADAY_CLOSE"],
            0.0,
        )

    def test_interval_folds_remove_training_labels_overlapping_validation(self):
        dates = np.asarray([
            f"2026-01-{day:02d}"
            for day in range(1, 13)
        ])
        starts = np.asarray([
            day * 1_000 for day in range(1, 13)
        ], dtype=np.int64)
        ends = starts + 100
        ends[5] = starts[6] + 10
        dataset = {
            "dates": dates,
            "label_start_ms": starts,
            "label_end_ms": ends,
        }

        folds = interval_expanding_folds(
            dataset,
            n_splits=2,
            calibration_fraction=0.25,
        )

        self.assertEqual(len(folds), 2)
        for fold in folds:
            validation_start = starts[fold["validation"]].min()
            self.assertTrue(
                np.all(ends[fold["train"]] < validation_start)
            )
            self.assertTrue(
                np.all(ends[fold["calibration"]] < validation_start)
            )
            self.assertEqual(
                len(set(fold["train"]) & set(fold["validation"])),
                0,
            )


if __name__ == "__main__":
    unittest.main()
