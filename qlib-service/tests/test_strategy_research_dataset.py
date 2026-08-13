import os
import sys
import tempfile
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from strategy_research_dataset import (
    build_strategy_dataset,
    load_prediction_snapshot,
)


def panel(last_close=10.2):
    return {
        "price_adjustment": "RAW",
        "amount_unit": "THOUSAND_CNY",
        "volume_unit": "SHARES",
        "dates": np.array(["20260105", "20260106", "20260107"]),
        "o": np.array([10.0, 10.1, 10.2]),
        "h": np.array([10.2, 10.3, 10.5]),
        "l": np.array([9.9, 10.0, 10.1]),
        "c": np.array([10.0, 10.2, last_close]),
        "v": np.array([1000.0, 1500.0, 2000.0]),
        "amount": np.array([100_000.0, 160_000.0, 220_000.0]),
        "b_turnover_rate_f": np.array([2.0, 3.0, 4.0]),
        "b_volume_ratio": np.array([1.0, 1.5, 2.0]),
        "m_net_mf_amount": np.array([100.0, 300.0, 500.0]),
    }


class PredictionSnapshotTest(unittest.TestCase):
    def test_loads_probability_as_quant_score_without_future_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "predictions.npz")
            np.savez_compressed(
                path,
                dates=np.array(["20260106"]),
                codes=np.array(["600001.SH"]),
                actual=np.array([1]),
                ensemble_prediction=np.array([0.73], dtype=np.float32),
            )

            snapshot = load_prediction_snapshot(
                path,
                score_key="ensemble_prediction",
            )

            self.assertAlmostEqual(
                snapshot[("20260106", "600001.SH")]["quantScore"],
                73.0,
                places=4,
            )
            self.assertNotIn(
                "actual",
                snapshot[("20260106", "600001.SH")],
            )

    def test_rejects_duplicate_date_code_predictions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "predictions.npz")
            np.savez_compressed(
                path,
                dates=np.array(["20260106", "20260106"]),
                codes=np.array(["600001.SH", "600001.SH"]),
                score=np.array([0.7, 0.8]),
            )

            with self.assertRaisesRegex(ValueError, "duplicate"):
                load_prediction_snapshot(path, score_key="score")


class StrategyResearchDatasetTest(unittest.TestCase):
    def test_builds_point_in_time_bar_and_records_evidence_provenance(self):
        predictions = {
            ("20260106", "600001.SH"): {
                "quantScore": 73.0,
                "scoreSource": "oos:model-v1",
            },
        }

        dataset = build_strategy_dataset(
            {"600001.SH": panel()},
            predictions,
            minimum_history=2,
        )

        self.assertEqual(dataset["schemaVersion"], "strategy-dataset.v1")
        self.assertEqual(len(dataset["bars"]), 1)
        bar = dataset["bars"][0]
        self.assertEqual(bar["date"], "20260106")
        self.assertEqual(bar["previousClose"], 10.0)
        self.assertEqual(bar["volume"], 1500.0)
        self.assertAlmostEqual(bar["pct"], 2.0)
        self.assertEqual(bar["quant"]["score"], 73.0)
        self.assertEqual(
            bar["evidenceSources"]["quant.score"],
            "OOS_PREDICTION",
        )
        self.assertEqual(
            bar["evidenceSources"]["marketScore"],
            "POINT_IN_TIME_DAILY_PROXY",
        )
        self.assertEqual(dataset["quality"]["futureFieldsUsed"], [])
        self.assertEqual(dataset["quality"]["usable"], True)

    def test_converts_tushare_volume_hands_to_shares(self):
        tushare_panel = panel()
        tushare_panel["volume_unit"] = "HANDS"
        predictions = {
            ("20260106", "600001.SH"): {
                "quantScore": 73.0,
                "scoreSource": "oos:model-v1",
            },
        }

        dataset = build_strategy_dataset(
            {"600001.SH": tushare_panel},
            predictions,
            minimum_history=2,
        )

        self.assertEqual(dataset["bars"][0]["volume"], 150_000.0)

    def test_future_price_changes_do_not_change_prior_point_in_time_record(self):
        predictions = {
            ("20260106", "600001.SH"): {
                "quantScore": 70.0,
                "scoreSource": "oos:model-v1",
            },
        }

        first = build_strategy_dataset(
            {"600001.SH": panel(last_close=10.2)},
            predictions,
            minimum_history=2,
        )
        second = build_strategy_dataset(
            {"600001.SH": panel(last_close=99.0)},
            predictions,
            minimum_history=2,
        )

        self.assertEqual(first["bars"], second["bars"])

    def test_missing_prediction_and_market_fields_are_reported_not_imputed(self):
        incomplete = panel()
        del incomplete["amount"]
        predictions = {
            ("20260106", "600001.SH"): {
                "quantScore": 70.0,
                "scoreSource": "oos:model-v1",
            },
            ("20260106", "600002.SH"): {
                "quantScore": 80.0,
                "scoreSource": "oos:model-v1",
            },
        }

        dataset = build_strategy_dataset(
            {"600001.SH": incomplete},
            predictions,
            minimum_history=2,
        )

        self.assertEqual(dataset["quality"]["usable"], False)
        self.assertIn(
            "amount",
            dataset["quality"]["missingRequiredFields"],
        )
        self.assertEqual(dataset["quality"]["unmatchedPredictions"], 1)
        self.assertEqual(dataset["bars"], [])

    def test_rejects_forward_adjusted_panel_for_execution_backtest(self):
        adjusted = panel()
        adjusted["price_adjustment"] = "QFQ"
        predictions = {
            ("20260106", "600001.SH"): {
                "quantScore": 70.0,
                "scoreSource": "oos:model-v1",
            },
        }

        dataset = build_strategy_dataset(
            {"600001.SH": adjusted},
            predictions,
            minimum_history=2,
        )

        self.assertEqual(dataset["quality"]["usable"], False)
        self.assertIn(
            "priceAdjustmentNotRaw",
            dataset["quality"]["missingRequiredFields"],
        )
        self.assertEqual(dataset["bars"], [])


if __name__ == "__main__":
    unittest.main()
