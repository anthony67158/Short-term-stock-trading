import unittest
from unittest.mock import patch

import numpy as np

from decision_engine.training import ensemble
from decision_engine.training.evaluation import ranking_metrics
from decision_engine.training.release import challenger_validation_blockers
from time_splits import three_way_purged_split


class CapturedBlend(Exception):
    pass


class StrategyReleaseIntegrityTest(unittest.TestCase):
    def test_ensemble_never_fits_calibration_or_blend_on_holdout(self):
        dates = np.arange("2026-01-01", "2026-05-01", dtype="datetime64[D]").astype(str)
        n = len(dates)
        data = {
            "X": np.arange(n).reshape(n, 1), "dates": dates,
            "codes": np.full(n, "600001"), "routes": np.full(n, "IMMEDIATE"),
            "playbook_ids": np.full(n, "MOMENTUM_BREAKOUT"),
            "y_net_r": np.arange(n, dtype=float),
        }
        train, calibration, holdout, _ = three_way_purged_split(
            dates, calibration_fraction=0.15, holdout_fraction=0.15, purge_dates=5,
        )
        predictions = lambda member, X, **_: {
            key: np.zeros(len(X)) for key in ("actionValue", "rankValue", "rankRaw", "q10")
        }
        with (
            patch.object(ensemble, "train_decision_model", return_value={"readiness": {"ready": True}}),
            patch.object(ensemble, "load_decision_dataset", return_value=data),
            patch.object(ensemble, "_fit_member", return_value={"config": {"rankingCalibration": {}}}) as fit,
            patch.object(ensemble, "_member_predictions", side_effect=predictions),
            patch.object(ensemble, "empirical_percentile", side_effect=lambda raw, _: raw),
            patch.object(ensemble, "select_ensemble_blend", side_effect=CapturedBlend) as blend,
        ):
            with self.assertRaises(CapturedBlend):
                ensemble.train_decision_ensemble("unused", "unused")
        for call in fit.call_args_list:
            np.testing.assert_array_equal(call.args[1], train)
            np.testing.assert_array_equal(call.args[2], calibration)
            self.assertEqual(len(np.intersect1d(call.args[2], holdout)), 0)
        np.testing.assert_array_equal(blend.call_args.args[3], data["y_net_r"][calibration])

    def test_not_ready_training_does_not_package_an_ensemble(self):
        report = {"state": "NOT_READY", "readiness": {"ready": False}}
        with (
            patch.object(ensemble, "train_decision_model", return_value=report),
            patch.object(ensemble, "load_decision_dataset") as load,
        ):
            self.assertEqual(ensemble.train_decision_ensemble("unused", "unused"), report)
        load.assert_not_called()

    def test_initial_losing_day_is_part_of_maximum_drawdown(self):
        result = ranking_metrics(
            [False, True], [-1.5, 0.1], [1, 1], ["2026-08-01", "2026-08-02"],
        )
        self.assertEqual(result["max_drawdown_r_at_5"], 1.5)

    def test_missing_or_overlapping_validation_cannot_qualify_for_release(self):
        self.assertEqual(len(challenger_validation_blockers({})), 2)
        validation = {
            "calibrationHoldoutSeparated": True,
            "calibrationEndDate": "2026-08-20",
            "holdoutStartDate": "2026-08-20",
            "walkForwardPassed": True,
        }
        self.assertTrue(challenger_validation_blockers({"ensembleValidation": validation}))
        validation["holdoutStartDate"] = "2026-08-28"
        self.assertEqual(challenger_validation_blockers({"ensembleValidation": validation}), [])


if __name__ == "__main__":
    unittest.main()
