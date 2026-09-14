import os
import sys
import unittest


SERVICE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from decision_engine.training.opportunity_reward import (  # noqa: E402
    capital_occupation_r,
    cost_aware_opportunity_reward,
    minimum_commission_drag_r,
    tail_loss_r,
)


FILLED = {
    "netR": "1.308",
    "totalFees": "10.67",
    "initialRiskCash": 44,
    "actualFillRiskCash": "43.62",
    "holdingTradingSessions": 2,
    "maePct": "-3.125",
}


class OpportunityRewardTest(unittest.TestCase):
    def test_defaults_preserve_raw_net_r(self):
        self.assertAlmostEqual(
            cost_aware_opportunity_reward(FILLED),
            1.308,
        )

    def test_unfilled_event_is_zero(self):
        self.assertEqual(
            cost_aware_opportunity_reward(FILLED, filled=False),
            0.0,
        )

    def test_base_r_overrides_metric_net_r(self):
        self.assertAlmostEqual(
            cost_aware_opportunity_reward(FILLED, base_r=0.5),
            0.5,
        )

    def test_missing_net_r_returns_zero(self):
        self.assertEqual(cost_aware_opportunity_reward({}), 0.0)

    def test_minimum_commission_drag_uses_risk_cash(self):
        # 10 CNY floor over 43.62 risk cash, but fees are 10.67 so forced
        # portion is capped at min(fees, 10) = 10.
        self.assertAlmostEqual(
            minimum_commission_drag_r(FILLED),
            10.0 / 43.62,
            places=6,
        )
        self.assertEqual(minimum_commission_drag_r({}), 0.0)

    def test_commission_penalty_reduces_reward_monotonically(self):
        base = cost_aware_opportunity_reward(FILLED)
        penalized = cost_aware_opportunity_reward(
            FILLED,
            min_commission_weight=1.0,
        )
        self.assertLess(penalized, base)
        self.assertAlmostEqual(base - penalized, 10.0 / 43.62, places=6)

    def test_capital_occupation_scales_with_sessions(self):
        self.assertAlmostEqual(
            capital_occupation_r(FILLED, daily_rate_r=0.01),
            0.02,
        )
        self.assertEqual(capital_occupation_r(FILLED), 0.0)
        self.assertEqual(
            capital_occupation_r({}, daily_rate_r=0.01),
            0.0,
        )

    def test_tail_penalty_only_beyond_threshold(self):
        self.assertEqual(tail_loss_r(FILLED), 0.0)
        self.assertEqual(
            tail_loss_r(FILLED, mae_threshold_pct=5.0),
            0.0,
        )
        self.assertAlmostEqual(
            tail_loss_r(FILLED, mae_threshold_pct=2.0),
            (3.125 - 2.0) / 100.0,
            places=6,
        )

    def test_combined_penalties_are_additive(self):
        reward = cost_aware_opportunity_reward(
            FILLED,
            turnover_penalty_r=0.01,
            min_commission_weight=1.0,
            capital_daily_rate_r=0.01,
            tail_weight=1.0,
            tail_threshold_pct=2.0,
        )
        expected = (
            1.308
            - 0.01
            - 10.0 / 43.62
            - 0.02
            - (3.125 - 2.0) / 100.0
        )
        self.assertAlmostEqual(reward, expected, places=6)


if __name__ == "__main__":
    unittest.main()
