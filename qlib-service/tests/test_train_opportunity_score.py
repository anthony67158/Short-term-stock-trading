import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from opportunity_contract import FEATURE_NAMES  # noqa: E402
from train_opportunity_score import (  # noqa: E402
    load_opportunity_dataset,
    train_opportunity_score,
)


def dataset(samples=40, dates_count=20):
    dates = np.asarray([
        f"2026-{(index // 28) + 1:02d}-{(index % 28) + 1:02d}"
        for index in range(dates_count)
        for _ in range(max(1, samples // dates_count))
    ])[:samples]
    X = np.zeros((len(dates), len(FEATURE_NAMES)), dtype=np.float32)
    y_fill = np.asarray(
        [index % 2 for index in range(len(dates))],
        dtype=np.int8,
    )
    y_win = np.full(len(dates), np.nan, dtype=np.float32)
    y_net_r = np.full(len(dates), np.nan, dtype=np.float32)
    filled = np.flatnonzero(y_fill == 1)
    for offset, index in enumerate(filled):
        y_win[index] = float(offset % 2)
        y_net_r[index] = 1.0 if offset % 2 else -1.0
        X[index, 1] = y_win[index]
        X[index, 2] = y_net_r[index]
    X[:, 0] = y_fill
    return {
        "X": X,
        "dates": dates,
        "codes": np.asarray(
            [f"{600000 + index:06d}" for index in range(len(dates))],
        ),
        "formula_ids": np.asarray(["FORMULA_A"] * len(dates)),
        "y_fill": y_fill,
        "y_win": y_win,
        "y_net_r": y_net_r,
        "feature_names": np.asarray(FEATURE_NAMES),
    }


class FakeClassifier:
    def __init__(self, column=0):
        self.column = column
        self.booster_ = self

    def predict_proba(self, X):
        probability = np.where(X[:, self.column] > 0, 0.75, 0.25)
        return np.column_stack([1 - probability, probability])

    def save_model(self, path):
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(f"classifier:{self.column}")


class FakeRegressor:
    def __init__(self):
        self.booster_ = self

    def predict(self, X):
        return X[:, 2]

    def save_model(self, path):
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("regressor")


class TrainOpportunityScoreTest(unittest.TestCase):
    def test_loader_rejects_feature_contract_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "dataset.npz")
            value = dataset()
            value["feature_names"] = np.asarray(["wrong"])
            np.savez_compressed(path, **value)

            with self.assertRaisesRegex(ValueError, "特征合同不一致"):
                load_opportunity_dataset(path)

    def test_insufficient_dataset_writes_not_ready_without_models(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "dataset.npz")
            np.savez_compressed(path, **dataset())

            report = train_opportunity_score(
                path,
                directory,
                now=1_788_320_000,
            )

            self.assertEqual(report["state"], "NOT_READY")
            self.assertFalse(report["shadowEligible"])
            self.assertFalse(os.path.exists(os.path.join(
                directory,
                "opportunity_fill_lgb.txt",
            )))
            self.assertTrue(os.path.exists(os.path.join(
                directory,
                "opportunity_trials.jsonl",
            )))

    def test_ready_dataset_trains_three_heads_and_keeps_shadow_only(self):
        value = dataset(samples=1200, dates_count=120)

        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "dataset.npz")
            np.savez_compressed(path, **value)
            with (
                patch(
                    "train_opportunity_score._fit_lgb_classifier",
                    side_effect=[
                        FakeClassifier(0),
                        FakeClassifier(1),
                    ],
                ),
                patch(
                    "train_opportunity_score._fit_logistic_classifier",
                    side_effect=[
                        FakeClassifier(0),
                        FakeClassifier(1),
                    ],
                ),
                patch(
                    "train_opportunity_score._fit_lgb_regressor",
                    return_value=FakeRegressor(),
                ),
                patch(
                    "train_opportunity_score._fit_linear_regressor",
                    return_value=FakeRegressor(),
                ),
            ):
                report = train_opportunity_score(
                    path,
                    directory,
                    now=1_788_320_000,
                    minimum_dates=60,
                )

            self.assertEqual(report["state"], "SHADOW_READY")
            self.assertTrue(report["shadowEligible"])
            self.assertFalse(report["productionEligible"])
            self.assertIn("pFill", report["metrics"])
            self.assertIn("pWinGivenFill", report["metrics"])
            self.assertIn("expectedNetR", report["metrics"])
            self.assertIn("ranking", report["metrics"])
            for filename in (
                "opportunity_fill_lgb.txt",
                "opportunity_win_lgb.txt",
                "opportunity_netr_lgb.txt",
                "opportunity_meta.json",
            ):
                self.assertTrue(os.path.exists(
                    os.path.join(directory, "shadow", filename),
                ))
            with open(
                os.path.join(
                    directory,
                    "shadow",
                    "opportunity_meta.json",
                ),
                encoding="utf-8",
            ) as handle:
                meta = json.load(handle)
            self.assertEqual(meta["featureNames"], list(FEATURE_NAMES))
            self.assertTrue(meta["shadowOnly"])
            self.assertFalse(meta["productionEligible"])


if __name__ == "__main__":
    unittest.main()
