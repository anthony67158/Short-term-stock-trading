import unittest

from promote_opportunity_model import (
    production_model_version,
    promotion_decision,
)


def report(**challenger_overrides):
    challenger = {
        "netRLowerBound": 0.08,
        "mean_net_r_at_5": 0.36,
        "max_drawdown_r_at_5": 0.8,
        "precision_at_5": 0.62,
        **challenger_overrides,
    }
    return {
        "state": "SHADOW_READY",
        "walkForward": {
            "shadowEligible": True,
            "folds": 3,
        },
        "metrics": {
            "ranking": {
                "challenger": challenger,
                "baseline": {
                    "mean_net_r_at_5": 0.25,
                    "max_drawdown_r_at_5": 0.8,
                    "precision_at_5": 0.58,
                },
            },
        },
    }


class OpportunityPromotionTest(unittest.TestCase):
    def test_production_version_is_distinct_from_shadow_release(self):
        self.assertEqual(
            production_model_version("opportunity-score.20260909"),
            "opportunity-score.20260909.production",
        )
        self.assertEqual(
            production_model_version(
                "opportunity-score.20260909.production"
            ),
            "opportunity-score.20260909.production",
        )

    def test_promotes_only_when_return_and_drawdown_gates_pass(self):
        decision = promotion_decision(report())

        self.assertTrue(decision["eligible"])
        self.assertEqual(decision["blockers"], [])

    def test_rejects_non_positive_lower_bound(self):
        decision = promotion_decision(report(netRLowerBound=-0.01))

        self.assertFalse(decision["eligible"])
        self.assertTrue(any(
            "下置信界" in blocker
            for blocker in decision["blockers"]
        ))

    def test_rejects_drawdown_regression(self):
        decision = promotion_decision(report(max_drawdown_r_at_5=1.2))

        self.assertFalse(decision["eligible"])
        self.assertTrue(any(
            "最大回撤" in blocker
            for blocker in decision["blockers"]
        ))

    def test_daily_gate_requires_joint_model_stability(self):
        decision = promotion_decision(
            report(),
            {"combination": {"eligible": False}},
        )

        self.assertFalse(decision["eligible"])
        self.assertTrue(any(
            "CatBoost排序" in blocker
            for blocker in decision["blockers"]
        ))

    def test_ensemble_uses_current_aggregate_and_keeps_negative_fold_blocker(self):
        value = report(netRLowerBound=-0.5, mean_net_r_at_5=-0.2)
        value["seedEnsemble"] = {
            "aggregate": {
                "top5MeanNetR": 0.33,
                "top5LowerBound": 0.1,
            },
            "folds": [
                {"meanNetRAt5": 0.6},
                {"meanNetRAt5": 0.4},
                {"meanNetRAt5": -0.05},
            ],
        }

        decision = promotion_decision(value)

        self.assertFalse(decision["eligible"])
        self.assertEqual(decision["metrics"]["netRLowerBound"], 0.1)
        self.assertEqual(
            decision["metrics"]["challengerMeanNetRAt5"],
            0.33,
        )
        self.assertFalse(any(
            "下置信界未大于0" in blocker
            for blocker in decision["blockers"]
        ))
        self.assertTrue(any(
            "负收益独立窗口" in blocker
            for blocker in decision["blockers"]
        ))


if __name__ == "__main__":
    unittest.main()
