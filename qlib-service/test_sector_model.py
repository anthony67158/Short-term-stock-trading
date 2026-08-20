import unittest
import subprocess
import sys

import numpy as np

from sector_model import (
    FEATURE_NAMES,
    feature_vector,
    predict_sector_items,
)


class FakeBooster:
    def __init__(self, values):
        self.values = values
        self.seen = None

    def predict(self, matrix):
        self.seen = np.asarray(matrix)
        return np.asarray(self.values[: len(matrix)], dtype=float)


class SectorModelTest(unittest.TestCase):
    def test_runtime_model_import_does_not_require_pandas(self):
        script = (
            "import sys; "
            "sys.modules['pandas']=None; "
            "import sector_model; "
            "assert len(sector_model.FEATURE_NAMES)==14"
        )
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=".",
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_runtime_vector_uses_explicit_feature_order(self):
        factors = {
            name: index + 0.5
            for index, name in enumerate(reversed(FEATURE_NAMES))
        }
        vector = feature_vector(factors)

        self.assertEqual(len(vector), len(FEATURE_NAMES))
        self.assertEqual(
            vector,
            [float(factors[name]) for name in FEATURE_NAMES],
        )

    def test_dual_head_prediction_is_additive_and_bounded(self):
        next_model = FakeBooster([0.82, 1.5])
        week_model = FakeBooster([0.74, -0.2])
        items = [{
            "code": "BK1000",
            "factors": {name: 50 for name in FEATURE_NAMES},
        }, {
            "code": "BK1001",
            "factors": {name: 40 for name in FEATURE_NAMES},
        }]

        result = predict_sector_items(
            items,
            models=(next_model, week_model),
            meta={"modelVersion": "sector-test"},
        )

        self.assertEqual(result[0]["nextProbability"], 0.82)
        self.assertEqual(result[0]["weekProbability"], 0.74)
        self.assertEqual(result[1]["nextProbability"], 1.0)
        self.assertEqual(result[1]["weekProbability"], 0.0)
        self.assertEqual(result[0]["modelVersion"], "sector-test")
        self.assertEqual(next_model.seen.shape, (2, len(FEATURE_NAMES)))

    def test_invalid_code_or_factor_payload_is_rejected(self):
        with self.assertRaises(ValueError):
            predict_sector_items([{"code": "../bad", "factors": {}}], models=(
                FakeBooster([0.5]),
                FakeBooster([0.5]),
            ))


if __name__ == "__main__":
    unittest.main()
