import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

import numpy as np


SERVICE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from decision_engine.heads.review_contract import FEATURE_NAMES  # noqa: E402
from decision_engine.training.review_ensemble import (  # noqa: E402
    _fit_member,
    train_review_ensemble,
)


class DecisionReviewTrainingTest(unittest.TestCase):
    def dataset(self):
        samples_per_date = 10
        date_count = 50
        dates = np.repeat(np.asarray([
            f"2026-01-{day:02d}"
            if day <= 31
            else f"2026-02-{day - 31:02d}"
            for day in range(1, date_count + 1)
        ]), samples_per_date)
        starts = np.arange(1, len(dates) + 1, dtype=np.int64) * 1_000
        matrix = np.zeros(
            (len(dates), len(FEATURE_NAMES)),
            dtype=np.float32,
        )
        matrix[:, 0] = np.arange(len(dates), dtype=np.float32)
        groups = np.asarray([
            f"600001:event-{index}"
            for index in range(len(dates))
        ])
        return {
            "X": matrix,
            "X_all": matrix.copy(),
            "dates_all": dates.copy(),
            "dates": dates,
            "codes": np.asarray(["600001"] * len(dates)),
            "event_group_ids": groups,
            "event_group_ids_all": groups.copy(),
            "label_start_ms_all": starts.copy(),
            "label_end_ms_all": starts + 50,
            "label_start_ms": starts,
            "label_end_ms": starts + 100,
            "y_fill": np.arange(len(dates)) % 2,
            "y_win": np.arange(len(dates)) % 2,
            "y_net_r": np.where(
                np.arange(len(dates)) % 2,
                1.0,
                -1.0,
            ),
        }

    def test_training_reserves_selection_and_confirmation_partitions(self):
        dataset = self.dataset()

        def member(
            _dataset,
            _train,
            _calibration,
            _fill_train,
            _fill_calibration,
            seed,
            _estimators,
            _threads,
        ):
            return {
                "config": {
                    "seed": seed,
                    "activeFeatures": [0],
                    "activeFillFeatures": [0],
                    "pFillCalibration": {"method": "sigmoid"},
                    "pWinCalibration": {"method": "sigmoid"},
                    "q10CalibrationOffset": 0.0,
                },
                "models": {"mock": object()},
            }

        def predictions(_member, matrix):
            return {
                "pFill": np.full(len(matrix), 0.5),
                "pWinGivenFill": np.full(len(matrix), 0.5),
                "expectedNetR": np.zeros(len(matrix)),
                "netRLowerBound": np.full(len(matrix), -1.0),
            }

        def evaluation(_dataset, _development, indices, _predictions):
            return {"samples": len(indices)}, []

        with tempfile.TemporaryDirectory() as output:
            with ExitStack() as stack:
                stack.enter_context(patch(
                    "decision_engine.training.review_ensemble.load_dataset",
                    return_value=dataset,
                ))
                stack.enter_context(patch(
                    "decision_engine.training.review_ensemble._fit_member",
                    side_effect=member,
                ))
                stack.enter_context(patch(
                    "decision_engine.training.review_ensemble."
                    "_member_predictions",
                    side_effect=predictions,
                ))
                evaluate = stack.enter_context(patch(
                    "decision_engine.training.review_ensemble._evaluate",
                    side_effect=evaluation,
                ))
                stack.enter_context(patch(
                    "decision_engine.training.review_ensemble."
                    "_catboost_payload",
                    return_value={},
                ))
                stack.enter_context(patch(
                    "decision_engine.training.review_ensemble."
                    "validate_review_metadata",
                ))
                metadata = train_review_ensemble(
                    "unused.json",
                    output,
                    seeds=(42, 7),
                )

        selection = evaluate.call_args_list[0].args[2]
        confirmation = evaluate.call_args_list[1].args[2]
        self.assertFalse(set(selection.tolist()) & set(confirmation.tolist()))
        self.assertEqual(
            metadata["validation"]["selectionMetrics"]["samples"],
            len(selection),
        )
        self.assertEqual(
            metadata["validation"]["confirmationMetrics"]["samples"],
            len(confirmation),
        )
        self.assertLess(
            metadata["validation"]["selectionEndDate"],
            metadata["validation"]["confirmationStartDate"],
        )

    def test_training_rejects_fill_labels_without_both_classes(self):
        dataset = self.dataset()
        dataset["y_fill"] = np.ones(len(dataset["X_all"]), dtype=np.int8)
        development = np.arange(0, 200)
        calibration = np.arange(200, 260)

        with self.assertRaisesRegex(ValueError, "成交训练集缺少正负样本"):
            _fit_member(
                dataset,
                development,
                calibration,
                development,
                calibration,
                42,
                10,
                1,
            )


if __name__ == "__main__":
    unittest.main()
