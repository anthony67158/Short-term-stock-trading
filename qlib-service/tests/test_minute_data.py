import importlib.util
import os
import tempfile
import unittest
from datetime import datetime

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODULE_PATH = os.path.join(HERE, "..", "minute_data.py")


def load_module():
    spec = importlib.util.spec_from_file_location("minute_data", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TushareCodeTest(unittest.TestCase):
    def test_converts_cached_exchange_prefix_codes(self):
        minute_data = load_module()

        self.assertEqual(
            minute_data.to_tushare_code("sh600519"),
            "600519.SH",
        )
        self.assertEqual(
            minute_data.to_tushare_code("sz300750"),
            "300750.SZ",
        )

    def test_rejects_invalid_codes(self):
        minute_data = load_module()

        with self.assertRaises(ValueError):
            minute_data.to_tushare_code("600519")


class CalendarWindowTest(unittest.TestCase):
    def test_month_windows_cover_the_requested_range_without_overlap(self):
        minute_data = load_module()

        windows = list(
            minute_data.month_windows(
                datetime(2024, 1, 15, 9, 30),
                datetime(2024, 3, 5, 15, 0),
            )
        )

        self.assertEqual(
            windows,
            [
                (
                    datetime(2024, 1, 15, 9, 30),
                    datetime(2024, 1, 31, 15, 0),
                ),
                (
                    datetime(2024, 2, 1, 9, 30),
                    datetime(2024, 2, 29, 15, 0),
                ),
                (
                    datetime(2024, 3, 1, 9, 30),
                    datetime(2024, 3, 5, 15, 0),
                ),
            ],
        )

    def test_multi_month_windows_start_each_following_slice_at_market_open(self):
        minute_data = load_module()

        windows = list(
            minute_data.calendar_windows(
                datetime(2024, 1, 15, 9, 30),
                datetime(2024, 7, 5, 15, 0),
                months_per_request=6,
            )
        )

        self.assertEqual(
            windows,
            [
                (
                    datetime(2024, 1, 15, 9, 30),
                    datetime(2024, 6, 30, 15, 0),
                ),
                (
                    datetime(2024, 7, 1, 9, 30),
                    datetime(2024, 7, 5, 15, 0),
                ),
            ],
        )


class NormalizationTest(unittest.TestCase):
    def test_sorts_deduplicates_and_validates_rows(self):
        minute_data = load_module()
        rows = [
            {
                "ts_code": "600519.SH",
                "trade_time": "2026-07-29 09:35:00",
                "open": "1410",
                "high": "1412",
                "low": "1409",
                "close": "1411",
                "vol": "100",
                "amount": "141100",
            },
            {
                "ts_code": "600519.SH",
                "trade_time": "2026-07-29 09:30:00",
                "open": "1400",
                "high": "1405",
                "low": "1399",
                "close": "1403",
                "vol": "200",
                "amount": "280600",
            },
            {
                "ts_code": "600519.SH",
                "trade_time": "2026-07-29 09:35:00",
                "open": "1410",
                "high": "1412",
                "low": "1409",
                "close": "1411",
                "vol": "100",
                "amount": "141100",
            },
        ]

        normalized = minute_data.normalize_rows(rows, "600519.SH")

        self.assertEqual(
            [row["trade_time"] for row in normalized],
            ["2026-07-29 09:30:00", "2026-07-29 09:35:00"],
        )
        self.assertEqual(normalized[0]["amount"], 280600.0)

    def test_rejects_non_finite_or_invalid_ohlc_rows(self):
        minute_data = load_module()

        with self.assertRaises(ValueError):
            minute_data.normalize_rows(
                [
                    {
                        "ts_code": "600519.SH",
                        "trade_time": "2026-07-29 09:30:00",
                        "open": "10",
                        "high": "9",
                        "low": "8",
                        "close": "10",
                        "vol": "1",
                        "amount": "10",
                    }
                ],
                "600519.SH",
            )


class MonthCacheTest(unittest.TestCase):
    def setUp(self):
        self.minute_data = load_module()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.code = "600519.SH"
        self.start = datetime(2026, 7, 1, 9, 30)
        self.end = datetime(2026, 7, 31, 15, 0)
        self.rows = [
            {
                "ts_code": self.code,
                "trade_time": "2026-07-29 09:30:00",
                "open": 1400,
                "high": 1405,
                "low": 1399,
                "close": 1403,
                "vol": 200,
                "amount": 280600,
            }
        ]

    def test_round_trips_a_month_cache_with_metadata(self):
        path = self.minute_data.month_cache_path(
            self.temp.name,
            "5min",
            self.code,
            self.start,
        )

        self.minute_data.write_month_cache(
            path,
            frequency="5min",
            code=self.code,
            start=self.start,
            end=self.end,
            rows=self.rows,
        )
        metadata, rows = self.minute_data.load_month_cache(
            path,
            expected_frequency="5min",
            expected_code=self.code,
            expected_start=self.start,
            expected_end=self.end,
        )

        self.assertEqual(metadata["rows"], 1)
        self.assertEqual(rows, self.rows)

    def test_reuses_a_valid_cache_without_making_a_network_call(self):
        path = self.minute_data.month_cache_path(
            self.temp.name,
            "5min",
            self.code,
            self.start,
        )
        self.minute_data.write_month_cache(
            path,
            frequency="5min",
            code=self.code,
            start=self.start,
            end=self.end,
            rows=self.rows,
        )

        class ForbiddenClient:
            def rows(self, *_args, **_kwargs):
                raise AssertionError("cache hit must not call Tushare")

        status = self.minute_data.download_month(
            ForbiddenClient(),
            root=self.temp.name,
            frequency="5min",
            code=self.code,
            start=self.start,
            end=self.end,
        )

        self.assertEqual(status["status"], "cached")
        self.assertEqual(status["rows"], 1)

    def test_downloads_the_month_with_documented_stk_mins_parameters(self):
        minute_data = self.minute_data

        class Client:
            def __init__(self):
                self.arguments = None

            def rows(self, api_name, params, fields):
                self.arguments = (api_name, params, fields)
                return self_rows

        self_rows = self.rows
        client = Client()
        status = minute_data.download_month(
            client,
            root=self.temp.name,
            frequency="5min",
            code=self.code,
            start=self.start,
            end=self.end,
        )

        self.assertEqual(status["status"], "downloaded")
        self.assertEqual(status["rows"], 1)
        self.assertEqual(client.arguments[0], "stk_mins")
        self.assertEqual(client.arguments[1]["ts_code"], self.code)
        self.assertEqual(client.arguments[1]["freq"], "5min")
        self.assertEqual(
            client.arguments[2],
            ",".join(minute_data.MINUTE_FIELDS),
        )

    def test_rejects_corrupt_cached_metadata(self):
        path = self.minute_data.month_cache_path(
            self.temp.name,
            "5min",
            self.code,
            self.start,
        )
        os.makedirs(os.path.dirname(path), exist_ok=True)
        np.savez_compressed(
            path,
            metadata=np.array('{"frequency":"1min"}'),
        )

        with self.assertRaises(ValueError):
            self.minute_data.load_month_cache(
                path,
                expected_frequency="5min",
                expected_code=self.code,
                expected_start=self.start,
                expected_end=self.end,
            )

    def test_repairs_a_small_number_of_invalid_source_rows_when_opted_in(self):
        minute_data = self.minute_data

        class Client:
            def rows(self, *_args, **_kwargs):
                return [
                    self_rows[0],
                    {
                        **self_rows[0],
                        "trade_time": "2026-07-29 09:35:00",
                        "high": 1300,
                    },
                ]

        self_rows = self.rows
        result = minute_data.download_month(
            Client(),
            root=self.temp.name,
            frequency="5min",
            code=self.code,
            start=self.start,
            end=self.end,
            allow_source_row_drops=True,
            max_source_row_drop_fraction=0.5,
        )

        self.assertEqual(result["status"], "repaired")
        self.assertEqual(result["rows"], 1)
        self.assertEqual(result["dropped_rows"], 1)

    def test_repair_rejects_an_excessive_invalid_row_fraction(self):
        minute_data = self.minute_data

        class Client:
            def rows(self, *_args, **_kwargs):
                return [
                    {
                        **self_rows[0],
                        "trade_time": f"2026-07-29 09:{30 + index:02d}:00",
                        "high": 1300,
                    }
                    for index in range(2)
                ]

        self_rows = self.rows
        with self.assertRaisesRegex(ValueError, "2/2"):
            minute_data.download_month(
                Client(),
                root=self.temp.name,
                frequency="5min",
                code=self.code,
                start=self.start,
                end=self.end,
                allow_source_row_drops=True,
            )

    def test_repair_keeps_days_that_meet_the_minimum_bar_count(self):
        minute_data = self.minute_data
        day_one = []
        for index in range(40):
            hour = 9 + (30 + index * 5) // 60
            minute = (30 + index * 5) % 60
            day_one.append(
                {
                    **self.rows[0],
                    "trade_time": f"2026-07-27 {hour:02d}:{minute:02d}:00",
                }
            )
        rows = [
            *day_one,
            {
                **day_one[-1],
                "trade_time": "2026-07-27 14:55:00",
                "high": 1300,
            },
            {
                **self.rows[0],
                "trade_time": "2026-07-28 09:30:00",
            },
            {
                **self.rows[0],
                "trade_time": "2026-07-28 09:35:00",
                "high": 1300,
            },
        ]

        class Client:
            def rows(self, *_args, **_kwargs):
                return rows

        result = minute_data.download_month(
            Client(),
            root=self.temp.name,
            frequency="5min",
            code=self.code,
            start=self.start,
            end=self.end,
            allow_source_row_drops=True,
            minimum_valid_bars_per_day=40,
            max_source_day_drop_fraction=0.5,
        )

        self.assertEqual(result["status"], "repaired")
        self.assertEqual(result["rows"], 40)
        self.assertEqual(result["dropped_rows"], 3)
        self.assertEqual(result["dropped_trading_days"], 1)


class UniverseDownloadTest(unittest.TestCase):
    def test_downloads_every_month_for_each_requested_code(self):
        minute_data = load_module()
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        requested = []

        class Client:
            def rows(self, api_name, params, _fields):
                requested.append((api_name, params))
                return [
                    {
                        "ts_code": params["ts_code"],
                        "trade_time": params["start_date"],
                        "open": 10,
                        "high": 10,
                        "low": 10,
                        "close": 10,
                        "vol": 0,
                        "amount": 0,
                    }
                ]

        summary = minute_data.download_universe(
            Client(),
            root=temp.name,
            frequency="5min",
            codes=["sh600519"],
            start=datetime(2026, 1, 15, 9, 30),
            end=datetime(2026, 2, 2, 15, 0),
        )

        self.assertEqual(summary["requested_slices"], 2)
        self.assertEqual(summary["downloaded_slices"], 2)
        self.assertEqual(summary["failed_slices"], [])
        self.assertEqual(len(requested), 2)
        self.assertEqual(
            [params["ts_code"] for _api, params in requested],
            ["600519.SH", "600519.SH"],
        )

    def test_reports_a_failed_slice_instead_of_claiming_a_complete_universe(self):
        minute_data = load_module()
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)

        class Client:
            def rows(self, *_args, **_kwargs):
                raise RuntimeError("provider unavailable")

        summary = minute_data.download_universe(
            Client(),
            root=temp.name,
            frequency="5min",
            codes=["sh600519"],
            start=datetime(2026, 1, 15, 9, 30),
            end=datetime(2026, 1, 31, 15, 0),
        )

        self.assertEqual(summary["requested_slices"], 1)
        self.assertEqual(summary["completed_slices"], 0)
        self.assertEqual(len(summary["failed_slices"]), 1)
        self.assertEqual(summary["failed_slices"][0]["code"], "600519.SH")
        self.assertEqual(
            summary["failed_slices"][0]["error_message"],
            "provider unavailable",
        )

    def test_retries_only_failed_slices_and_merges_the_report(self):
        minute_data = load_module()
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        requested = []

        class Client:
            def rows(self, api_name, params, _fields):
                requested.append((api_name, params))
                return [
                    {
                        "ts_code": params["ts_code"],
                        "trade_time": params["start_date"],
                        "open": 10,
                        "high": 10,
                        "low": 10,
                        "close": 10,
                        "vol": 1,
                        "amount": 10,
                    }
                ]

        report = {
            "codes": 2,
            "requested_slices": 2,
            "completed_slices": 1,
            "downloaded_slices": 1,
            "cached_slices": 0,
            "rows": 48,
            "failed_slices": [
                {
                    "code": "300750.SZ",
                    "start": "2026-01-01 09:30:00",
                    "end": "2026-06-30 15:00:00",
                    "error_type": "ValueError",
                }
            ],
        }

        summary = minute_data.retry_failed_slices(
            Client(),
            root=temp.name,
            frequency="5min",
            report=report,
        )

        self.assertEqual(len(requested), 1)
        self.assertEqual(requested[0][1]["ts_code"], "300750.SZ")
        self.assertEqual(summary["requested_slices"], 2)
        self.assertEqual(summary["completed_slices"], 2)
        self.assertEqual(summary["downloaded_slices"], 2)
        self.assertEqual(summary["rows"], 49)
        self.assertEqual(summary["failed_slices"], [])

    def test_expands_failed_windows_into_monthly_recovery_slices(self):
        minute_data = load_module()
        failures = [
            {
                "code": "600519.SH",
                "start": "2026-01-01 09:30:00",
                "end": "2026-03-15 15:00:00",
                "error_type": "ValueError",
            }
        ]

        slices = minute_data.expand_failed_slices_by_month(failures)

        self.assertEqual(
            [(item["start"], item["end"]) for item in slices],
            [
                ("2026-01-01 09:30:00", "2026-01-31 15:00:00"),
                ("2026-02-01 09:30:00", "2026-02-28 15:00:00"),
                ("2026-03-01 09:30:00", "2026-03-15 15:00:00"),
            ],
        )

    def test_allows_known_source_quality_exclusions_above_coverage_gate(self):
        minute_data = load_module()
        report = {
            "requested_slices": 10,
            "completed_slices": 9,
            "failed_slices": [
                {
                    "error_type": "ValueError",
                    "error_message": "分钟 high 小于 open/close",
                }
            ],
        }

        quality = minute_data.validate_download_report_for_training(report)

        self.assertEqual(quality["coverage"], 0.9)
        self.assertEqual(quality["source_quality_exclusions"], 1)

    def test_allows_an_audited_monthly_quality_gap(self):
        minute_data = load_module()
        report = {
            "requested_slices": 100,
            "completed_slices": 99,
            "failed_slices": [
                {
                    "error_type": "ValueError",
                    "error_message": "分钟月度数据质量缺口",
                }
            ],
        }

        quality = minute_data.validate_download_report_for_training(report)

        self.assertEqual(quality["coverage"], 0.99)
        self.assertEqual(quality["source_quality_exclusions"], 1)

    def test_rejects_unknown_download_failures(self):
        minute_data = load_module()
        report = {
            "requested_slices": 10,
            "completed_slices": 9,
            "failed_slices": [
                {
                    "error_type": "RuntimeError",
                    "error_message": "provider unavailable",
                }
            ],
        }

        with self.assertRaises(ValueError):
            minute_data.validate_download_report_for_training(report)


if __name__ == "__main__":
    unittest.main()
