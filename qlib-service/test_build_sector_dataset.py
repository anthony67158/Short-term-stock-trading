import os
import tempfile
import unittest

from build_sector_dataset import (
    build_dataset_file,
    merge_sector_panel,
    update_sector_panel,
)


class FakeClient:
    def __init__(self):
        self.calls = []

    def ths_index(self, exchange="A", index_type=None):
        return [
            {
                "ts_code": "885001.TI",
                "name": "机器人",
                "count": 30,
                "type": "N",
            },
            {
                "ts_code": "881001.TI",
                "name": "电子",
                "count": 80,
                "type": "I",
            },
        ]

    def trade_cal(self, start_date=None, end_date=None):
        return [
            {"cal_date": "20260819", "is_open": "1"},
            {"cal_date": "20260820", "is_open": "1"},
        ]

    def ths_daily(self, **params):
        self.calls.append(("ths_daily", params))
        day = params.get("trade_date")
        code = params.get("ts_code")
        rows = []
        codes = [code] if code else ["885001.TI", "881001.TI"]
        dates = [day] if day else ["20260819", "20260820"]
        for current_code in codes:
            for current_day in dates:
                rows.append({
                    "ts_code": current_code,
                    "trade_date": current_day,
                    "open": 100,
                    "high": 102,
                    "low": 99,
                    "close": 101,
                    "pct_change": 1,
                    "vol": 1000,
                    "turnover_rate": 2,
                })
        return rows

    def moneyflow_ind_ths(self, **params):
        self.calls.append(("moneyflow_ind_ths", params))
        day = params.get("trade_date") or "20260820"
        code = params.get("ts_code") or "881001.TI"
        return [{
            "ts_code": code,
            "trade_date": day,
            "net_amount": 5,
            "net_buy_amount": 20,
            "net_sell_amount": 15,
            "company_num": 80,
            "pct_change_stock": 3,
        }]


class BuildSectorDatasetTest(unittest.TestCase):
    def test_merge_keeps_concept_rows_without_fake_zero_price(self):
        merged = merge_sector_panel(
            [{
                "ts_code": "885001.TI",
                "trade_date": "20260820",
                "open": 100,
                "high": 102,
                "low": 99,
                "close": 101,
            }],
            [],
            [{"ts_code": "885001.TI", "name": "机器人", "count": 30}],
        )

        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["close"], 101)
        self.assertIsNone(merged[0]["net_amount"])
        self.assertEqual(merged[0]["company_num"], 30)

    def test_existing_cache_updates_by_missing_trade_date(self):
        client = FakeClient()
        existing = [{
            "ts_code": "885001.TI",
            "trade_date": "20260819",
            "open": 100,
            "high": 101,
            "low": 99,
            "close": 100,
        }]

        updated = update_sector_panel(
            client,
            existing,
            start_date="20260819",
            end_date="20260820",
        )

        daily_calls = [
            params
            for name, params in client.calls
            if name == "ths_daily"
        ]
        self.assertEqual(daily_calls, [{"trade_date": "20260820"}])
        self.assertTrue(
            any(row["trade_date"] == "20260820" for row in updated),
        )

    def test_dataset_file_contains_dual_labels_and_feature_names(self):
        client = FakeClient()
        rows = []
        for day in range(1, 10):
            for index, code in enumerate(
                ["885001.TI", "881001.TI", "885002.TI",
                 "881002.TI", "885003.TI"]
            ):
                rows.append({
                    "ts_code": code,
                    "trade_date": f"202608{day:02d}",
                    "open": 100 + index,
                    "high": 102 + index + day,
                    "low": 99 + index,
                    "close": 101 + index + day,
                    "pct_change": day * (5 - index) / 10,
                    "vol": 1000 + index * 100,
                    "turnover_rate": 2,
                    "net_amount": day * (5 - index),
                    "net_buy_amount": 20,
                    "net_sell_amount": 10,
                    "company_num": 30,
                    "pct_change_stock": 2,
                })
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "sector_dataset.npz")
            result = build_dataset_file(rows, path)

            self.assertGreater(result["samples"], 0)
            import numpy as np
            data = np.load(path, allow_pickle=True)
            self.assertIn("y_next", data.files)
            self.assertIn("y_week", data.files)
            self.assertEqual(
                data["X"].shape[1],
                len(data["feat_names"]),
            )


if __name__ == "__main__":
    unittest.main()
