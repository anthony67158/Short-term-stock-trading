import importlib.util
import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODULE_PATH = os.path.join(HERE, "..", "train_intraday_v21_lgbm.py")


def load_trainer():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "train_intraday_v21_lgbm",
            MODULE_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(SERVICE_ROOT)


class IntradayV21LightGbmTest(unittest.TestCase):
    def test_sequence_summary_contains_causal_window_statistics(self):
        trainer = load_trainer()
        values = np.arange(2 * 4 * 2, dtype=np.float32).reshape(2, 4, 2)

        result = trainer.sequence_summary_features(values)

        self.assertEqual(result.shape, (2, 12))
        np.testing.assert_allclose(result[0, 0:2], [6, 7])
        np.testing.assert_allclose(result[0, 2:4], [3, 4])
        np.testing.assert_allclose(result[0, 6:8], [0, 1])
        np.testing.assert_allclose(result[0, 8:10], [6, 7])
        np.testing.assert_allclose(result[0, 10:12], [6, 6])

    def test_indexed_summary_appends_stable_stock_category(self):
        trainer = load_trainer()
        values = np.arange(3 * 4 * 2, dtype=np.float32).reshape(3, 4, 2)
        codes = np.asarray(["600519.SH", "000001.SZ", "600519.SH"])

        result, categories = trainer.summarize_indexed_sequences(
            values,
            np.asarray([2, 1]),
            codes,
            chunk_size=1,
        )

        self.assertEqual(result.shape, (2, 13))
        self.assertEqual(categories, ["000001.SZ", "600519.SH"])
        self.assertEqual(result[:, -1].astype(int).tolist(), [1, 0])

    def test_cross_sectional_context_uses_only_same_as_of_stocks(self):
        trainer = load_trainer()
        values = np.zeros((4, 2, 12), dtype=np.float32)
        values[:, -1, 0] = [1.0, 3.0, 10.0, 14.0]
        values[:, -1, 6] = [-1.0, 1.0, 2.0, 4.0]
        values[:, -1, 8] = [-2.0, 2.0, -3.0, 3.0]
        as_of = np.asarray(["t1", "t1", "t2", "t2"])

        context = trainer.build_cross_sectional_context(values, as_of)
        selected = trainer.select_cross_sectional_features(
            values,
            np.asarray([0, 2]),
            context,
        )

        self.assertEqual(selected.shape, (2, 27))
        self.assertEqual(selected[0, 0], 2.0)
        self.assertEqual(selected[1, 0], 12.0)
        self.assertEqual(selected[0, 12], -1.0)
        self.assertEqual(selected[1, 12], -2.0)
        np.testing.assert_allclose(selected[0, -3:], [1.0, 0.5, 0.5])
        np.testing.assert_allclose(selected[1, -3:], [1.0, 1.0, 0.5])


if __name__ == "__main__":
    unittest.main()
