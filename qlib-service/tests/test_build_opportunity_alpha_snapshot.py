import importlib.util
import os
import sys
import unittest
from unittest.mock import patch

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SERVICE_ROOT = os.path.join(ROOT, "qlib-service")
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

_SPEC = importlib.util.spec_from_file_location(
    "build_opportunity_alpha_snapshot",
    os.path.join(ROOT, "scripts", "build-opportunity-alpha-snapshot.py"),
)
builder = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(builder)

from decision_engine.training.opportunity_alpha import date_start_ms  # noqa: E402


class OpportunityAlphaSnapshotTest(unittest.TestCase):
    def test_panel_target_alignment_uses_date_and_code(self):
        panel = {
            "dates": np.asarray(["20260102", "20260103", "20260102"]),
            "codes": np.asarray(["600001", "600001", "600002"]),
        }
        targets = {
            "dates": np.asarray(["20260102", "20260103"]),
            "codes": np.asarray(["600002", "600001"]),
        }

        target_rows, panel_rows = builder._aligned_target_rows(
            panel,
            targets,
        )

        self.assertEqual(target_rows.tolist(), [0, 1])
        self.assertEqual(panel_rows.tolist(), [2, 1])

    def test_walkforward_scores_only_after_causal_warmup(self):
        dates = [
            "20260102",
            "20260105",
            "20260106",
            "20260107",
            "20260108",
            "20260109",
        ]
        codes = [f"60000{index}" for index in range(1, 7)]
        panel_dates = np.repeat(np.asarray(dates), len(codes))
        panel_codes = np.tile(np.asarray(codes), len(dates))
        first_feature = np.tile(np.arange(len(codes)), len(dates))
        panel = {
            "dates": panel_dates,
            "codes": panel_codes,
            "X": np.column_stack([
                first_feature,
                np.ones(len(panel_dates)),
            ]).astype(np.float32),
        }
        targets = {
            "dates": panel_dates.copy(),
            "codes": panel_codes.copy(),
            "y_best_net_r": first_feature.astype(np.float32),
            "y_best_net_r_stress10": (
                first_feature.astype(np.float32) - 0.1
            ),
            "label_start_ms": np.asarray([
                date_start_ms(date) + 1_000
                for date in panel_dates
            ]),
            "label_end_ms": np.asarray([
                date_start_ms(date) + 2_000
                for date in panel_dates
            ]),
        }

        class Model:
            def predict(self, matrix):
                return matrix[:, 0]

        with patch.object(
            builder,
            "aggregate_stock_day_targets",
            return_value=targets,
        ), patch.object(
            builder,
            "_fit_regressor",
            return_value=Model(),
        ):
            snapshot, report = builder.build_snapshot(
                panel,
                {},
                warmup_days=2,
                block_days=2,
                minimum_training_samples=6,
            )

        self.assertEqual(report["blocks"][0]["scoreStartDate"], "20260106")
        self.assertEqual(report["blocks"][0]["trainEndDate"], "20260105")
        self.assertAlmostEqual(report["coverage"], 4 / 6, places=6)
        self.assertEqual(
            sorted({row["date"] for row in snapshot["rows"]}),
            dates[2:],
        )
        self.assertEqual(report["top5"]["lowerBound95"], 3.0)


if __name__ == "__main__":
    unittest.main()
