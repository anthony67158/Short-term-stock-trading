import importlib.util
import os
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
EXECUTION_PATH = os.path.join(HERE, "..", "ashare_execution.py")


def load_execution():
    spec = importlib.util.spec_from_file_location(
        "ashare_execution",
        EXECUTION_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AshareMarketRuleTest(unittest.TestCase):
    def setUp(self):
        self.execution = load_execution()

    def test_applies_board_specific_daily_price_limits(self):
        self.assertEqual(
            self.execution.price_limit_pct("600519.SH", "20260810"),
            0.10,
        )
        self.assertEqual(
            self.execution.price_limit_pct("300750.SZ", "20260810"),
            0.20,
        )
        self.assertEqual(
            self.execution.price_limit_pct("300750.SZ", "20200821"),
            0.10,
        )
        self.assertEqual(
            self.execution.price_limit_pct("688981.SH", "20260810"),
            0.20,
        )
        self.assertEqual(
            self.execution.price_limit_pct("830799.BJ", "20260810"),
            0.30,
        )
        self.assertEqual(
            self.execution.price_limit_pct(
                "600519.SH",
                "20260810",
                is_st=True,
            ),
            0.05,
        )

    def test_uses_exchange_half_up_rounding_for_limit_prices(self):
        lower, upper = self.execution.limit_prices(10.05, 0.10)

        self.assertEqual(lower, 9.05)
        self.assertEqual(upper, 11.06)

    def test_rejects_suspended_and_one_price_limit_fills(self):
        self.assertFalse(
            self.execution.can_fill_open(
                side="buy",
                previous_close=10.0,
                open_price=11.0,
                volume=1000,
                limit_pct=0.10,
            )
        )
        self.assertFalse(
            self.execution.can_fill_open(
                side="sell",
                previous_close=10.0,
                open_price=9.0,
                volume=1000,
                limit_pct=0.10,
            )
        )
        self.assertFalse(
            self.execution.can_fill_open(
                side="buy",
                previous_close=10.0,
                open_price=10.0,
                volume=0,
                limit_pct=0.10,
            )
        )
        self.assertTrue(
            self.execution.can_fill_open(
                side="buy",
                previous_close=10.0,
                open_price=10.5,
                volume=1000,
                limit_pct=0.10,
            )
        )


class AshareFeeTest(unittest.TestCase):
    def setUp(self):
        self.execution = load_execution()

    def test_charges_minimum_commission_and_transfer_fee_on_buy(self):
        fees = self.execution.trade_fees("buy", 10_000.0)

        self.assertAlmostEqual(fees["commission"], 5.0)
        self.assertAlmostEqual(fees["stamp_duty"], 0.0)
        self.assertAlmostEqual(fees["transfer"], 0.1)
        self.assertAlmostEqual(fees["total"], 5.1)

    def test_charges_stamp_duty_only_on_sell(self):
        fees = self.execution.trade_fees("sell", 100_000.0)

        self.assertAlmostEqual(fees["commission"], 30.0)
        self.assertAlmostEqual(fees["stamp_duty"], 50.0)
        self.assertAlmostEqual(fees["transfer"], 1.0)
        self.assertAlmostEqual(fees["total"], 81.0)


class AshareLongTradeTest(unittest.TestCase):
    def setUp(self):
        self.execution = load_execution()

    def test_enforces_t_plus_one_after_the_entry_fill(self):
        result = self.execution.simulate_long_trade(
            code="600519.SH",
            dates=np.array(["20260810", "20260811", "20260812"]),
            opens=np.array([10.0, 10.0, 10.5]),
            closes=np.array([10.0, 10.2, 10.6]),
            volumes=np.array([1000, 1000, 1000]),
            signal_index=0,
            requested_exit_index=1,
            quantity=100,
            slippage_bps=0,
        )

        self.assertEqual(result["entry_index"], 1)
        self.assertEqual(result["exit_index"], 2)
        self.assertEqual(result["status"], "closed")

    def test_delays_exit_until_limit_down_is_released(self):
        result = self.execution.simulate_long_trade(
            code="600519.SH",
            dates=np.array(
                ["20260810", "20260811", "20260812", "20260813"]
            ),
            opens=np.array([10.0, 10.0, 9.18, 9.4]),
            closes=np.array([10.0, 10.2, 9.18, 9.5]),
            volumes=np.array([1000, 1000, 1000, 1000]),
            signal_index=0,
            requested_exit_index=2,
            quantity=100,
            slippage_bps=0,
        )

        self.assertEqual(result["exit_index"], 3)
        self.assertEqual(result["status"], "closed")

    def test_returns_unfilled_when_entry_opens_at_limit_up(self):
        result = self.execution.simulate_long_trade(
            code="600519.SH",
            dates=np.array(["20260810", "20260811", "20260812"]),
            opens=np.array([10.0, 11.0, 11.2]),
            closes=np.array([10.0, 11.0, 11.3]),
            volumes=np.array([1000, 1000, 1000]),
            signal_index=0,
            requested_exit_index=2,
            quantity=100,
        )

        self.assertEqual(result["status"], "entry_unfilled")


if __name__ == "__main__":
    unittest.main()
