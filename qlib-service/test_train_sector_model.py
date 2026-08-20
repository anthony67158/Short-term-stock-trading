import unittest
from unittest.mock import patch

import numpy as np

from train_sector_model import (
    _load_champion,
    collect_hard_errors,
    hard_error_sample_weights,
    ranking_metrics,
    should_promote_heads,
)


class SectorTrainingTest(unittest.TestCase):
    def test_champion_load_prefers_current_oss_hot_model(self):
        models = (object(), object())
        meta = {"modelVersion": "sector-oss-current"}
        with patch(
            "sector_model.get_sector_models",
            return_value=(models, meta),
        ):
            loaded, loaded_meta = _load_champion()

        self.assertIs(loaded, models)
        self.assertEqual(loaded_meta["modelVersion"], "sector-oss-current")

    def test_hard_error_weights_are_two_to_three_x_and_decay(self):
        dates = np.asarray(["20260801", "20260819", "20260820"])
        codes = np.asarray(["A", "B", "C"])
        memory = {
            "samples": [{
                "sampleKey": "20260801:A:next",
                "confidence": 1.0,
                "label": 0,
            }, {
                "sampleKey": "20260820:C:next",
                "confidence": 1.0,
                "label": 1,
            }],
        }

        weights, report = hard_error_sample_weights(
            dates,
            codes,
            "next",
            memory,
            half_life_dates=10,
            normalize=False,
        )

        self.assertGreaterEqual(weights[2], 2.0)
        self.assertLessEqual(weights[2], 3.0)
        self.assertGreater(weights[2], weights[0])
        self.assertEqual(weights[1], 1.0)
        self.assertEqual(report["matched_n"], 2)

    def test_ranking_metrics_are_computed_per_trade_date(self):
        labels = np.asarray([1, 0, 0, 0, 0, 0, 1, 0, 0, 0])
        probabilities = np.asarray([
            0.9, 0.8, 0.7, 0.6, 0.5,
            0.9, 0.8, 0.7, 0.6, 0.5,
        ])
        dates = np.asarray(["20260819"] * 5 + ["20260820"] * 5)
        metrics = ranking_metrics(labels, probabilities, dates, top_k=2)

        self.assertGreater(metrics["ndcg_at_5"], 0.8)
        self.assertLess(metrics["ndcg_at_5"], 1.0)
        self.assertEqual(metrics["top5_precision"], 0.5)

    def test_only_high_confidence_wrong_predictions_enter_replay_memory(self):
        memory = collect_hard_errors(
            np.asarray(["20260820", "20260820", "20260820"]),
            np.asarray(["A", "B", "C"]),
            np.asarray([1, 0, 1]),
            np.asarray([0.1, 0.2, 0.6]),
            "next",
        )

        self.assertEqual(memory["total"], 1)
        self.assertEqual(
            memory["samples"][0]["sampleKey"],
            "20260820:A:next",
        )

    def test_both_heads_must_not_regress_and_one_must_improve(self):
        champion = {
            "next": {
                "auc": 0.60,
                "logloss": 0.65,
                "ndcg_at_5": 0.40,
                "top5_precision": 0.30,
            },
            "week": {
                "auc": 0.58,
                "logloss": 0.66,
                "ndcg_at_5": 0.38,
                "top5_precision": 0.28,
            },
        }
        challenger = {
            "next": {
                "auc": 0.62,
                "logloss": 0.63,
                "ndcg_at_5": 0.45,
                "top5_precision": 0.34,
            },
            "week": {
                "auc": 0.58,
                "logloss": 0.66,
                "ndcg_at_5": 0.38,
                "top5_precision": 0.28,
            },
        }

        self.assertTrue(
            should_promote_heads(champion, challenger)["promote"],
        )
        regressed = {
            **challenger,
            "week": {
                **challenger["week"],
                "logloss": 0.70,
            },
        }
        self.assertFalse(
            should_promote_heads(champion, regressed)["promote"],
        )


if __name__ == "__main__":
    unittest.main()
