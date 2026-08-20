import unittest

import pandas as pd

from sector_factors import (
    FEATURE_NAMES,
    build_sector_feature_frame,
    build_sector_training_frame,
)


def sample_panel():
    dates = pd.bdate_range("2026-08-03", periods=8)
    rows = []
    for sector_index in range(5):
        code = f"88500{sector_index}.TI"
        for day_index, date in enumerate(dates):
            daily_return = (5 - sector_index) * (day_index + 1) * 0.1
            close = 100 + sector_index + daily_return
            rows.append({
                "ts_code": code,
                "trade_date": date.strftime("%Y%m%d"),
                "open": close - 0.2,
                "high": close + 0.5,
                "low": close - 0.6,
                "close": close,
                "pct_change": daily_return,
                "vol": 1000 + sector_index * 100 + day_index * 20,
                "turnover_rate": 2 + sector_index * 0.1,
                "net_amount": (5 - sector_index) * (day_index + 1),
                "net_buy_amount": 20 + day_index,
                "net_sell_amount": 10 + sector_index,
                "company_num": 20 + sector_index,
                "pct_change_stock": daily_return + 0.5,
            })
    return pd.DataFrame(rows)


class SectorFactorTest(unittest.TestCase):
    def test_feature_frame_has_stable_runtime_contract(self):
        frame = build_sector_feature_frame(sample_panel())

        self.assertEqual(list(frame[FEATURE_NAMES].columns), FEATURE_NAMES)
        self.assertFalse(frame[FEATURE_NAMES].isna().any().any())
        self.assertTrue(frame["trade_date"].is_monotonic_increasing)

    def test_past_features_do_not_change_when_future_rows_change(self):
        panel = sample_panel()
        cutoff = "20260806"
        before = build_sector_feature_frame(panel)
        changed = panel.copy()
        changed.loc[
            changed["trade_date"] > cutoff,
            ["close", "pct_change", "net_amount"],
        ] *= 100
        after = build_sector_feature_frame(changed)

        left = before[before["trade_date"] <= cutoff].reset_index(drop=True)
        right = after[after["trade_date"] <= cutoff].reset_index(drop=True)
        pd.testing.assert_frame_equal(
            left[["ts_code", "trade_date", *FEATURE_NAMES]],
            right[["ts_code", "trade_date", *FEATURE_NAMES]],
        )

    def test_labels_use_next_close_and_t1_open_to_t5_close(self):
        frame = build_sector_training_frame(sample_panel())
        first_date = frame["trade_date"].min()
        first = frame[frame["trade_date"] == first_date]

        self.assertEqual(len(first), 5)
        self.assertEqual(int(first["label_next"].sum()), 1)
        self.assertEqual(int(first["label_week"].sum()), 1)
        self.assertEqual(
            first.sort_values("next_return", ascending=False)
            .iloc[0]["label_next"],
            1,
        )
        self.assertTrue(first["week_end_date"].notna().all())
        self.assertTrue(first["week_max_drawdown"].notna().all())

    def test_incomplete_future_window_is_not_a_negative_sample(self):
        frame = build_sector_training_frame(sample_panel())
        latest = frame["trade_date"].max()
        rows = frame[frame["trade_date"] == latest]

        self.assertTrue(rows["label_next"].isna().all())
        self.assertTrue(rows["label_week"].isna().all())


if __name__ == "__main__":
    unittest.main()
