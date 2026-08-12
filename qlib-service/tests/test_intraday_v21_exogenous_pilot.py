import importlib.util
import os
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
MODULE_PATH = os.path.join(
    HERE,
    "..",
    "intraday_v21_exogenous_pilot.py",
)


def load_module():
    spec = importlib.util.spec_from_file_location(
        "intraday_v21_exogenous_pilot",
        MODULE_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class IntradayV21ExogenousPilotTest(unittest.TestCase):
    def test_daily_flows_are_lagged_but_same_day_auction_is_allowed(self):
        module = load_module()
        cache = {
            "stocks": {
                "600519.SH": {
                    "daily_basic": [
                        {
                            "trade_date": "20260808",
                            "turnover_rate_f": 1.2,
                            "volume_ratio": 0.9,
                            "circ_mv": 1000,
                        },
                        {
                            "trade_date": "20260811",
                            "turnover_rate_f": 8.8,
                            "volume_ratio": 3.0,
                            "circ_mv": 1000,
                        },
                    ],
                    "moneyflow": [
                        {
                            "trade_date": "20260808",
                            "net_mf_amount": 100,
                            "buy_lg_amount": 80,
                            "sell_lg_amount": 30,
                            "buy_elg_amount": 40,
                            "sell_elg_amount": 10,
                        },
                        {
                            "trade_date": "20260811",
                            "net_mf_amount": -900,
                            "buy_lg_amount": 10,
                            "sell_lg_amount": 90,
                            "buy_elg_amount": 5,
                            "sell_elg_amount": 80,
                        },
                    ],
                    "auction": [
                        {
                            "trade_date": "20260811",
                            "price": 10.2,
                            "pre_close": 10.0,
                            "turnover_rate": 0.12,
                            "volume_ratio": 1.4,
                        },
                    ],
                },
            },
            "market_moneyflow": [
                {
                    "trade_date": "20260808",
                    "net_amount_rate": 2.5,
                    "buy_elg_amount_rate": 1.1,
                },
                {
                    "trade_date": "20260811",
                    "net_amount_rate": -9.0,
                    "buy_elg_amount_rate": -5.0,
                },
            ],
        }

        matrix, coverage = module.build_exogenous_features(
            np.asarray(["600519.SH"]),
            np.asarray(["2026-08-11"]),
            cache,
        )

        self.assertEqual(
            matrix.shape,
            (1, len(module.EXOGENOUS_FEATURE_NAMES)),
        )
        feature = dict(zip(module.EXOGENOUS_FEATURE_NAMES, matrix[0]))
        self.assertAlmostEqual(feature["prev_turnover_rate_f"], 0.012)
        self.assertAlmostEqual(feature["prev_volume_ratio"], 0.9)
        self.assertAlmostEqual(feature["prev_net_mf_intensity"], 0.1)
        self.assertAlmostEqual(feature["market_net_amount_rate"], 0.025)
        self.assertAlmostEqual(feature["auction_gap"], 0.02)
        self.assertAlmostEqual(coverage["stock_lagged"], 1.0)
        self.assertAlmostEqual(coverage["auction"], 1.0)

    def test_pilot_subset_keeps_same_rows_for_baseline_and_augmented_models(self):
        module = load_module()
        codes = np.asarray(
            ["A", "B", "A", "B", "A", "B", "C", "C"],
        )
        dates = np.asarray(
            [
                "2026-08-07",
                "2026-08-07",
                "2026-08-08",
                "2026-08-08",
                "2026-08-11",
                "2026-08-11",
                "2026-08-11",
                "2026-08-12",
            ],
        )

        selected = module.select_pilot_indices(
            codes,
            dates,
            max_codes=2,
            max_dates=2,
        )

        self.assertEqual(selected.tolist(), [2, 3, 4, 5])


if __name__ == "__main__":
    unittest.main()
