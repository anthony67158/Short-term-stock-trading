import importlib.util
import os
import sys
import types
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))


def load_retrain_daily():
    lightgbm = types.ModuleType("lightgbm")
    sklearn = types.ModuleType("sklearn")
    metrics = types.ModuleType("sklearn.metrics")
    metrics.roc_auc_score = lambda y, p: 0.5
    train_lgb = types.ModuleType("train_lgb")
    train_lgb.cv_auc_and_iters = lambda *args, **kwargs: (0.5, 120)
    train_lgb.fit_final = lambda *args, **kwargs: None
    sys.modules["lightgbm"] = lightgbm
    sys.modules["sklearn"] = sklearn
    sys.modules["sklearn.metrics"] = metrics
    sys.modules["train_lgb"] = train_lgb

    spec = importlib.util.spec_from_file_location(
        "retrain_daily_under_test", os.path.join(HERE, "retrain_daily.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ForwardHoldoutSplitTest(unittest.TestCase):
    def test_sync_preserves_migration_fields_for_the_same_champion(self):
        retrain = load_retrain_daily()
        remote = {"trained_at": 1785929794, "holdout_auc": 0.6521}
        bundled = {
            "trained_at": 1785929794,
            "data_end_date": "2026-07-29",
            "evaluation_protocol": "same_forward_unseen_holdout",
        }

        merged = retrain.merge_champion_metadata(remote, bundled)

        self.assertEqual(merged["data_end_date"], "2026-07-29")
        self.assertEqual(merged["evaluation_protocol"], "same_forward_unseen_holdout")
        self.assertEqual(merged["holdout_auc"], 0.6521)

    def test_only_dates_after_champion_data_end_are_evaluated(self):
        retrain = load_retrain_daily()
        dates = np.array([
            "20260728", "20260729", "20260730",
            "20260731", "20260803", "20260803",
        ])

        train_idx, hold_idx, hold_dates = retrain.forward_holdout_split(
            dates, "20260729"
        )

        self.assertEqual(dates[train_idx].tolist(), ["20260728", "20260729"])
        self.assertEqual(
            dates[hold_idx].tolist(),
            ["20260730", "20260731", "20260803", "20260803"],
        )
        self.assertEqual(hold_dates, ["20260730", "20260731", "20260803"])

    def test_rejects_holdout_without_enough_samples_or_dates(self):
        retrain = load_retrain_daily()

        self.assertFalse(
            retrain.forward_holdout_ready(
                holdout_n=999, holdout_dates=["20260730", "20260731", "20260803"],
                min_samples=1000, min_dates=3,
            )
        )
        self.assertFalse(
            retrain.forward_holdout_ready(
                holdout_n=1000, holdout_dates=["20260730", "20260731"],
                min_samples=1000, min_dates=3,
            )
        )
        self.assertTrue(
            retrain.forward_holdout_ready(
                holdout_n=1000, holdout_dates=["20260730", "20260731", "20260803"],
                min_samples=1000, min_dates=3,
            )
        )


if __name__ == "__main__":
    unittest.main()
