import importlib.util
import json
import os
import tempfile
import unittest
from unittest.mock import patch


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

        tiny_negative = self.module._minute_rows(
            [{
                "ts_code": "920001.BJ",
                "trade_time": "2026-07-08 13:40:00",
                "open": 13.25,
                "close": 13.250000000000004,
                "high": 13.249999999999996,
                "low": 13.250000000000009,
                "vol": 0,
                "amount": -1.4551915228366852e-09,
            }],
            "920001",
            {"20260708"},
        )
        self.assertEqual(tiny_negative[0][-1], 0)

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

    def test_retry_budget_is_explicitly_bounded(self):
        args = self.module.parse_args([
            "--stage",
            "minutes",
            "--work-dir",
            os.path.expanduser("~/.test-tushare-history"),
            "--manifest",
            "manifest.json",
            "--output-dir",
            os.path.expanduser("~/.test-tushare-minutes"),
            "--retries",
            "24",
            "--dry-run",
        ])

        self.assertEqual(args.retries, 24)
        with self.assertRaises(SystemExit):
            self.module.parse_args([
                "--stage",
                "minutes",
                "--work-dir",
                os.path.expanduser("~/.test-tushare-history"),
                "--manifest",
                "manifest.json",
                "--retries",
                "49",
                "--dry-run",
            ])

    def test_mcp_minute_source_supports_bounded_workers(self):
        args = self.module.parse_args([
            "--stage",
            "minutes",
            "--work-dir",
            os.path.expanduser("~/.test-mcp-history"),
            "--manifest",
            "manifest.json",
            "--output-dir",
            os.path.expanduser("~/.test-mcp-minutes"),
            "--minute-source",
            "mcp",
            "--workers",
            "4",
            "--dry-run",
        ])

        self.assertEqual(args.minute_source, "mcp")
        self.assertEqual(args.workers, 4)
        with self.assertRaises(SystemExit):
            self.module.parse_args([
                "--stage",
                "minutes",
                "--work-dir",
                os.path.expanduser("~/.test-mcp-history"),
                "--manifest",
                "manifest.json",
                "--minute-source",
                "mcp",
                "--workers",
                "9",
                "--dry-run",
            ])

    def test_http_source_derives_root_endpoint_and_token_from_mcp_url(self):
        with patch.dict(os.environ, {
            "STOCK_MCP_URL": (
                "https://tx.xiaodefa.top/mcp?token=test-only-token"
            ),
        }):
            token, endpoint = self.module._stock_http_config()

        self.assertEqual(token, "test-only-token")
        self.assertEqual(endpoint, "https://tx.xiaodefa.top/")

    def test_mcp_download_defers_one_failed_code_without_blocking_others(self):
        attempts = {}

        class FakeClient:
            def stock_minutes(self, symbol, _start, _end):
                attempts[symbol] = attempts.get(symbol, 0) + 1
                if symbol == "600000.SH" and attempts[symbol] == 1:
                    raise RuntimeError("transient")
                return [{"ts_code": symbol}]

        with patch.object(self.module, "StockMcpClient", FakeClient):
            rows = list(self.module._download_mcp_rows(
                ["600000", "600001"],
                ["20260910", "20260911"],
                retries=1,
                workers=1,
            ))

        self.assertEqual(
            {code for code, _values in rows},
            {"600000", "600001"},
        )
        self.assertEqual(attempts["600000.SH"], 2)
        self.assertEqual(attempts["600001.SH"], 1)

    def test_mcp_ip_limit_keeps_session_and_backs_off(self):
        calls = []

        class FakeClient:
            def __init__(self):
                calls.append("init")

            def stock_minutes(self, symbol, _start, _end):
                calls.append(symbol)
                if calls.count(symbol) == 1:
                    raise self.module.StockMcpUpstreamLimitError("limited")
                return [{"ts_code": symbol}]

        FakeClient.module = self.module
        with patch.object(
            self.module,
            "StockMcpClient",
            FakeClient,
        ), patch.object(
            self.module.time,
            "sleep",
        ) as sleep:
            rows = list(self.module._download_mcp_rows(
                ["600000"],
                ["20260910", "20260911"],
                retries=2,
                workers=1,
            ))

        self.assertEqual(rows[0][0], "600000")
        self.assertEqual(calls.count("init"), 1)
        self.assertGreaterEqual(sleep.call_count, 1)


if __name__ == "__main__":
    unittest.main()
