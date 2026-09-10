import importlib.util
import json
import os
import tempfile
import unittest


SCRIPT = os.path.abspath(os.path.join(
    os.path.dirname(__file__),
    "..",
    "..",
    "scripts",
    "tushare_export_history.py",
))


def load_module():
    spec = importlib.util.spec_from_file_location(
        "tushare_export_history",
        SCRIPT,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TushareHistoryExportTest(unittest.TestCase):
    def setUp(self):
        self.module = load_module()

    def test_normalizes_daily_units_and_fund_buckets(self):
        daily = self.module.normalize_daily_rows(
            [{
                "ts_code": "600519.SH",
                "trade_date": "20260722",
                "open": 10,
                "high": 11,
                "low": 9,
                "close": 10.5,
                "pre_close": 10,
                "vol": 123,
                "amount": 456,
            }],
            [{
                "ts_code": "600519.SH",
                "turnover_rate": 2.5,
                "volume_ratio": 1.2,
                "float_share": 1000,
            }],
            {"600519": "贵州茅台"},
        )
        self.assertEqual(daily[0]["volume"], 12_300)
        self.assertEqual(daily[0]["amount"], 456_000)
        self.assertEqual(daily[0]["turnover"], 2.5)

        funds = self.module.normalize_fund_rows([{
            "ts_code": "600519.SH",
            "trade_date": "20260722",
            "buy_sm_amount": 100,
            "sell_sm_amount": 300,
            "buy_lg_amount": 800,
            "sell_lg_amount": 200,
            "buy_elg_amount": 500,
            "sell_elg_amount": 100,
        }])
        self.assertEqual(funds[0]["mainNetYi"], 0.1)
        self.assertEqual(funds[0]["retailNetYi"], -0.02)

    def test_manifest_rejects_duplicates_and_unsupported_markets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "manifest.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({
                    "dates": [{
                        "date": "20260722",
                        "codes": ["600519", "600519"],
                    }],
                }, handle)
            with self.assertRaisesRegex(ValueError, "股票代码无效"):
                self.module.load_manifest(path)

            with open(path, "w", encoding="utf-8") as handle:
                json.dump({
                    "dates": [{
                        "date": "20260722",
                        "codes": ["400001"],
                    }],
                }, handle)
            with self.assertRaisesRegex(ValueError, "市场无效"):
                self.module.load_manifest(path)

    def test_minute_rows_are_filtered_to_requested_dates(self):
        rows = self.module._minute_rows(
            [{
                "ts_code": "600519.SH",
                "trade_time": "2026-07-22 09:35:00",
                "open": 10,
                "high": 10.2,
                "low": 9.9,
                "close": 10.1,
                "vol": 100,
                "amount": 1000,
            }, {
                "ts_code": "600519.SH",
                "trade_time": "2026-07-23 09:35:00",
                "open": 10,
                "high": 10.2,
                "low": 9.9,
                "close": 10.1,
                "vol": 100,
                "amount": 1000,
            }],
            "600519",
            {"20260722"},
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], "20260722")

    def test_minute_rows_normalize_binary_float_noise_before_ohlc_checks(self):
        rows = self.module._minute_rows(
            [{
                "ts_code": "000001.SZ",
                "trade_time": "2026-07-02 15:00:00",
                "open": 10.279999999999998,
                "close": 10.279999999999998,
                "high": 10.279999999999996,
                "low": 10.27,
                "vol": 2049100,
                "amount": 21062661.02000002,
            }],
            "000001",
            {"20260702"},
        )

        self.assertEqual(rows[0][3], 10.28)
        self.assertEqual(rows[0][4], 10.28)

    def test_minute_rows_exclude_whole_zero_ohlcv_suspension_day(self):
        rows, exclusions = self.module._minute_rows(
            [{
                "ts_code": "001331.SZ",
                "trade_time": "2026-06-18 09:35:00",
                "open": 0,
                "close": 0,
                "high": 0,
                "low": 0,
                "vol": 0,
                "amount": 0,
            }, {
                "ts_code": "001331.SZ",
                "trade_time": "2026-06-18 09:40:00",
                "open": 10,
                "close": 10,
                "high": 10,
                "low": 10,
                "vol": 100,
                "amount": 1000,
            }, {
                "ts_code": "001331.SZ",
                "trade_time": "2026-06-19 09:35:00",
                "open": 144,
                "close": 0,
                "high": 144,
                "low": 0,
                "vol": 0,
                "amount": 0,
            }],
            "001331",
            {"20260618", "20260619"},
            include_exclusions=True,
        )

        self.assertEqual(rows, [])
        self.assertEqual(exclusions, ["20260618", "20260619"])


if __name__ == "__main__":
    unittest.main()
