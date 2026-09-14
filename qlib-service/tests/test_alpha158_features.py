import os
import sys
import unittest

import numpy as np


SERVICE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from decision_engine.training.alpha158_features import (  # noqa: E402
    FEATURE_NAMES,
    alpha158_matrix,
)


class Alpha158FeaturesTest(unittest.TestCase):
    def test_official_feature_order_contains_158_unique_names(self):
        self.assertEqual(len(FEATURE_NAMES), 158)
        self.assertEqual(len(set(FEATURE_NAMES)), 158)
        self.assertEqual(
            FEATURE_NAMES[:13],
            (
                "KMID",
                "KLEN",
                "KMID2",
                "KUP",
                "KUP2",
                "KLOW",
                "KLOW2",
                "KSFT",
                "KSFT2",
                "OPEN0",
                "HIGH0",
                "LOW0",
                "VWAP0",
            ),
        )
        self.assertEqual(FEATURE_NAMES[-1], "VSUMD60")

    def test_rising_series_matches_key_alpha158_formulas(self):
        close = np.arange(1.0, 81.0)
        open_ = close - 0.2
        high = close + 0.5
        low = close - 0.5
        volume = np.arange(100.0, 180.0)
        amount = close * volume
        matrix = alpha158_matrix(
            open_,
            high,
            low,
            close,
            volume,
            amount,
        )
        row = dict(zip(FEATURE_NAMES, matrix[-1]))

        self.assertEqual(matrix.shape, (80, 158))
        self.assertAlmostEqual(row["VWAP0"], 1.0)
        self.assertAlmostEqual(row["ROC5"], close[-6] / close[-1])
        self.assertAlmostEqual(
            row["MA5"],
            np.mean(close[-5:]) / close[-1],
        )
        self.assertAlmostEqual(row["RANK60"], 1.0)
        self.assertAlmostEqual(row["IMAX60"], 1.0)
        self.assertAlmostEqual(row["IMIN60"], 1 / 60)
        self.assertAlmostEqual(row["CNTP5"], 1.0)
        self.assertAlmostEqual(row["CNTN5"], 0.0)
        self.assertAlmostEqual(row["SUMP5"], 1.0)
        self.assertAlmostEqual(row["SUMN5"], 0.0)


if __name__ == "__main__":
    unittest.main()
