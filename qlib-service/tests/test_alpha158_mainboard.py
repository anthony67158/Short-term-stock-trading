import os
import sys
import unittest

import numpy as np


SERVICE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from decision_engine.training.alpha158_mainboard import (  # noqa: E402
    _folds,
    select_causal_universe,
)


class Alpha158MainboardTest(unittest.TestCase):
    def test_causal_universe_is_deterministic_and_excludes_other_boards(self):
        rows = []
        for index in range(120):
            code = f"600{index:03d}"
            rows.append({
                "date": "20260101",
                "code": code,
                "name": code,
                "close": 10,
                "amount": 100_000_000 - index,
                "turnover": 1,
            })
        rows.extend([
            {
                "date": "20260101",
                "code": "300001",
                "name": "创业板",
                "close": 10,
                "amount": 900_000_000,
                "turnover": 1,
            },
            {
                "date": "20260101",
                "code": "688001",
                "name": "科创板",
                "close": 10,
                "amount": 900_000_000,
                "turnover": 1,
            },
        ])

        first = select_causal_universe(rows, "20260102", limit=100)
        second = select_causal_universe(rows, "20260102", limit=100)

        self.assertEqual(first, second)
        self.assertEqual(len(first), 100)
        self.assertTrue(all(code.startswith("600") for code in first))

    def test_expanding_folds_purge_labels_crossing_next_partition(self):
        dates = np.asarray([
            f"202601{day:02d}"
            for day in range(1, 29)
        ])
        panel = {
            "dates": np.repeat(dates, 2),
            "label_end_dates": np.repeat(dates, 2),
        }
        folds = _folds(panel, splits=3)

        self.assertEqual(len(folds), 3)
        for fold in folds:
            calibration_start = min(
                panel["dates"][fold["calibration"]].tolist()
            )
            validation_start = min(
                panel["dates"][fold["validation"]].tolist()
            )
            self.assertTrue(np.all(
                panel["label_end_dates"][fold["train"]]
                < calibration_start
            ))
            self.assertTrue(np.all(
                panel["label_end_dates"][fold["calibration"]]
                < validation_start
            ))


if __name__ == "__main__":
    unittest.main()
