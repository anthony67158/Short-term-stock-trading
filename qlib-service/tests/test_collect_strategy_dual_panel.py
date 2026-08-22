import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from collect_strategy_dual_panel import build_dual_price_panel


class CollectStrategyDualPanelTest(unittest.TestCase):
    def test_builds_qfq_signal_stream_and_historical_security_state(self):
        daily = [
            {
                "trade_date": "20260105",
                "open": 10,
                "high": 10.2,
                "low": 9.9,
                "close": 10,
                "vol": 1000,
                "amount": 10000,
            },
            {
                "trade_date": "20260106",
                "open": 11,
                "high": 11.2,
                "low": 10.8,
                "close": 11,
                "vol": 1200,
                "amount": 13000,
            },
        ]
        panel = build_dual_price_panel(
            "600001.SH",
            daily,
            [
                {"trade_date": "20260105", "adj_factor": 1.0},
                {"trade_date": "20260106", "adj_factor": 1.1},
            ],
            [
                {
                    "trade_date": "20260105",
                    "turnover_rate_f": 2,
                    "volume_ratio": 1.2,
                },
                {
                    "trade_date": "20260106",
                    "turnover_rate_f": 3,
                    "volume_ratio": 1.5,
                },
            ],
            [],
            [{
                "name": "ST样本",
                "start_date": "20260101",
                "end_date": "20260105",
            }],
            [{"trade_date": "20260106"}],
            name="样本",
            list_date="20200101",
            requested_start="20260101",
            requested_end="20260131",
            market_regimes={
                "20260105": "TREND_STRONG",
                "20260106": "RISK_OFF",
            },
        )

        self.assertEqual(panel["dates"].tolist(), ["20260105", "20260106"])
        self.assertAlmostEqual(panel["qfq_c"][0], 10 / 1.1)
        self.assertAlmostEqual(panel["qfq_c"][1], 11)
        self.assertEqual(panel["is_st"].tolist(), [True, False])
        self.assertEqual(panel["is_suspended"].tolist(), [False, True])
        self.assertEqual(
            panel["market_regime"].tolist(),
            ["TREND_STRONG", "RISK_OFF"],
        )
        self.assertTrue(np.all(panel["listing_days"] > 0))
        self.assertEqual(str(panel["price_adjustment"]), "DUAL_QFQ_RAW")
        self.assertEqual(str(panel["signal_price"]), "QFQ")
        self.assertEqual(str(panel["execution_price"]), "RAW")

    def test_missing_adjustment_factor_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "adjustment"):
            build_dual_price_panel(
                "600001.SH",
                [{
                    "trade_date": "20260105",
                    "open": 10,
                    "high": 10.2,
                    "low": 9.9,
                    "close": 10,
                    "vol": 1000,
                    "amount": 10000,
                }],
                [],
                [],
                [],
                [],
                [],
                name="样本",
                list_date="20200101",
                requested_start="20260101",
                requested_end="20260131",
                market_regimes={"20260105": "TREND_STRONG"},
            )


if __name__ == "__main__":
    unittest.main()
