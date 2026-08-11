import importlib.util
import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
BUILDER_PATH = os.path.join(SERVICE_ROOT, "build_dataset_v2.py")


def load_builder():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "build_dataset_v2",
            BUILDER_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(SERVICE_ROOT)


class DailyV2DatasetTest(unittest.TestCase):
    def test_builds_aligned_features_and_all_label_heads(self):
        builder = load_builder()
        rows = 70
        panel = {
            "dates": np.array(
                [f"20260{1 + i // 28:02d}{1 + i % 28:02d}" for i in range(rows)]
            ),
            "o": np.full(rows, 10.0),
            "h": np.full(rows, 10.6),
            "l": np.full(rows, 9.9),
            "c": np.full(rows, 10.0),
            "v": np.linspace(1000, 2000, rows),
        }

        samples = builder.make_samples_from_panel(
            panel,
            min_hist=60,
            barrier_horizon=5,
            horizons=(1, 3, 5),
        )

        self.assertEqual(samples["X"].shape, (5, 36))
        self.assertEqual(samples["y_barrier"].shape, (5,))
        self.assertTrue(np.all(samples["y_barrier"] == 1))
        for horizon in (1, 3, 5):
            self.assertEqual(samples[f"y_return_{horizon}d"].shape, (5,))
            self.assertEqual(samples[f"y_mfe_{horizon}d"].shape, (5,))
            self.assertEqual(samples[f"y_mae_{horizon}d"].shape, (5,))
        self.assertTrue(np.isfinite(samples["X"]).all())

    def test_uses_only_rows_with_every_requested_forward_label(self):
        builder = load_builder()
        rows = 67
        prices = np.linspace(10.0, 11.0, rows)
        panel = {
            "dates": np.array([f"d{i:03d}" for i in range(rows)]),
            "o": prices,
            "h": prices + 0.1,
            "l": prices - 0.1,
            "c": prices,
            "v": np.full(rows, 1000.0),
        }

        samples = builder.make_samples_from_panel(
            panel,
            min_hist=60,
            barrier_horizon=5,
            horizons=(1, 3, 5),
        )

        self.assertEqual(samples["X"].shape[0], 2)
        self.assertEqual(samples["dates"].tolist(), ["d060", "d061"])


if __name__ == "__main__":
    unittest.main()
