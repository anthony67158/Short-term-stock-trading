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
    metrics.log_loss = lambda y, p, labels=None: 0.69
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

    def test_incremental_split_trains_on_early_new_dates_and_blind_tests_latest(self):
        retrain = load_retrain_daily()
        dates = np.array([
            "20260728", "20260729",
            "20260730", "20260730",
            "20260731", "20260731",
            "20260803", "20260803",
            "20260804", "20260804",
            "20260805", "20260805",
            "20260806", "20260806",
        ])

        train_idx, blind_idx, adapt_dates, blind_dates = (
            retrain.incremental_adaptation_split(
                dates,
                "20260729",
                blind_dates=3,
            )
        )

        self.assertEqual(
            adapt_dates,
            ["20260730", "20260731", "20260803"],
        )
        self.assertEqual(
            blind_dates,
            ["20260804", "20260805", "20260806"],
        )
        self.assertEqual(
            dates[train_idx].tolist(),
            [
                "20260728", "20260729",
                "20260730", "20260730",
                "20260731", "20260731",
                "20260803", "20260803",
            ],
        )
        self.assertEqual(
            dates[blind_idx].tolist(),
            [
                "20260804", "20260804",
                "20260805", "20260805",
                "20260806", "20260806",
            ],
        )

    def test_incremental_window_requires_adaptation_and_blind_samples(self):
        retrain = load_retrain_daily()

        self.assertFalse(retrain.incremental_window_ready(
            adapt_n=999,
            adapt_dates=["20260730", "20260731", "20260803"],
            blind_n=1000,
            blind_dates=["20260804", "20260805", "20260806"],
            min_adapt_samples=1000,
            min_adapt_dates=3,
            min_blind_samples=1000,
            min_blind_dates=3,
        ))
        self.assertTrue(retrain.incremental_window_ready(
            adapt_n=1000,
            adapt_dates=["20260730", "20260731", "20260803"],
            blind_n=1000,
            blind_dates=["20260804", "20260805", "20260806"],
            min_adapt_samples=1000,
            min_adapt_dates=3,
            min_blind_samples=1000,
            min_blind_dates=3,
        ))

    def test_insufficient_dates_still_report_available_blind_samples(self):
        retrain = load_retrain_daily()
        dates = np.array([
            "20260805", "20260806",
            "20260807", "20260807",
            "20260810", "20260810",
        ])

        train_idx, blind_idx, adapt_dates, blind_dates = (
            retrain.incremental_adaptation_split(
                dates,
                "20260806",
                blind_dates=3,
            )
        )

        self.assertEqual(
            dates[train_idx].tolist(),
            ["20260805", "20260806"],
        )
        self.assertEqual(
            dates[blind_idx].tolist(),
            ["20260807", "20260807", "20260810", "20260810"],
        )
        self.assertEqual(adapt_dates, [])
        self.assertEqual(blind_dates, ["20260807", "20260810"])

    def test_recent_and_new_samples_receive_more_training_weight(self):
        retrain = load_retrain_daily()
        dates = np.array([
            "20260102", "20260401", "20260729", "20260730", "20260803",
        ])

        weights = retrain.recency_sample_weights(
            dates,
            champion_data_end="20260729",
            half_life_dates=2,
            new_sample_boost=2.0,
            floor=0.25,
        )

        self.assertGreater(weights[-1], weights[-2])
        self.assertGreater(weights[-2], weights[2])
        self.assertGreater(weights[2], weights[0])
        self.assertAlmostEqual(float(weights.mean()), 1.0, places=6)

    def test_pending_error_queue_uses_actual_forward_backtest_counts(self):
        retrain = load_retrain_daily()

        summary = retrain.pending_hard_error_summary({
            "overall": {"total": 1125, "correct": 712},
        })

        self.assertEqual(summary, {
            "eligible_n": 1125,
            "hard_error_n": 413,
            "hard_error_rate": 0.3671,
        })
        self.assertIsNone(retrain.pending_hard_error_summary(None))

    def test_persistent_hard_errors_are_replayed_on_every_training_with_decay(self):
        retrain = load_retrain_daily()
        memory = {
            "schemaVersion": "production-hard-errors.v1",
            "samples": [
                {
                    "sampleKey": "20260807:sh000002",
                    "date": "20260807",
                    "code": "sh000002",
                    "label": 0,
                    "confidence": 0.8,
                },
                {
                    "sampleKey": "20260810:sh000003",
                    "date": "20260810",
                    "code": "sh000003",
                    "label": 1,
                    "confidence": 0.8,
                },
                {
                    "sampleKey": "20260810:sh999999",
                    "date": "20260810",
                    "code": "sh999999",
                    "label": 0,
                    "confidence": 1.0,
                },
            ],
        }

        weights, stats = retrain.persistent_hard_error_weights(
            np.ones(4, dtype=np.float32),
            np.array(["20260102", "20260807", "20260810", "20260811"]),
            np.array(["sh000001", "sh000002", "sh000003", "sh000004"]),
            memory,
            half_life_dates=2,
        )

        self.assertAlmostEqual(float(weights.mean()), 1.0, places=6)
        self.assertGreater(weights[1], weights[0])
        self.assertGreater(weights[2], weights[1])
        self.assertEqual(weights[0], weights[3])
        self.assertEqual(stats["memory_total"], 3)
        self.assertEqual(stats["matched_n"], 2)
        self.assertEqual(stats["matched_by_class"], {"0": 1, "1": 1})

    def test_replay_memory_cannot_weight_rows_absent_from_training_slice(self):
        retrain = load_retrain_daily()
        memory = {
            "samples": [{
                "sampleKey": "20260812:sh000003",
                "date": "20260812",
                "code": "sh000003",
                "label": 1,
                "confidence": 1.0,
            }],
        }

        weights, stats = retrain.persistent_hard_error_weights(
            np.ones(2, dtype=np.float32),
            np.array(["20260807", "20260810"]),
            np.array(["sh000001", "sh000002"]),
            memory,
        )

        np.testing.assert_allclose(weights, np.ones(2))
        self.assertEqual(stats["matched_n"], 0)

    def test_promotion_requires_non_degradation_and_a_real_improvement(self):
        retrain = load_retrain_daily()
        champion = {"auc": 0.610, "logloss": 0.660, "top_precision": 0.70}

        within_old_tolerance_but_worse = {
            "auc": 0.607,
            "logloss": 0.662,
            "top_precision": 0.70,
        }
        self.assertFalse(retrain.should_promote_metrics(
            champion,
            within_old_tolerance_but_worse,
        )["promote"])

        better_auc = {
            "auc": 0.614,
            "logloss": 0.659,
            "top_precision": 0.70,
        }
        decision = retrain.should_promote_metrics(champion, better_auc)
        self.assertTrue(decision["promote"])
        self.assertIn("auc_gain", decision["improvements"])

        better_precision_but_auc_stable = {
            "auc": 0.610,
            "logloss": 0.661,
            "top_precision": 0.73,
        }
        decision = retrain.should_promote_metrics(
            champion,
            better_precision_but_auc_stable,
        )
        self.assertTrue(decision["promote"])
        self.assertIn("top_precision_gain", decision["improvements"])


if __name__ == "__main__":
    unittest.main()
