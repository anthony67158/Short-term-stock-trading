import importlib.util
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODULE_PATH = os.path.join(SERVICE_ROOT, "build_intraday_v21_dataset.py")


def load_builder():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "build_intraday_v21_dataset",
            MODULE_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(SERVICE_ROOT)


def load_minute_data():
    spec = importlib.util.spec_from_file_location(
        "minute_data",
        os.path.join(SERVICE_ROOT, "minute_data.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def trading_times():
    values = []
    current = datetime(2026, 8, 10, 9, 35)
    while current.time() <= datetime(2026, 8, 10, 11, 30).time():
        values.append(current.strftime("%H:%M:%S"))
        current += timedelta(minutes=5)
    current = datetime(2026, 8, 10, 13, 5)
    while current.time() <= datetime(2026, 8, 10, 15, 0).time():
        values.append(current.strftime("%H:%M:%S"))
        current += timedelta(minutes=5)
    return values


def panel(days=("2026-08-07", "2026-08-10")):
    times = []
    opens = []
    highs = []
    lows = []
    closes = []
    volumes = []
    amounts = []
    for day in days:
        for value in trading_times():
            times.append(f"{day} {value}")
            opens.append(10.0)
            highs.append(10.01)
            lows.append(9.99)
            closes.append(10.0)
            volumes.append(1000.0)
            amounts.append(10000.0)
    return {
        "trade_time": np.asarray(times),
        "open": np.asarray(opens),
        "high": np.asarray(highs),
        "low": np.asarray(lows),
        "close": np.asarray(closes),
        "vol": np.asarray(volumes),
        "amount": np.asarray(amounts),
    }


class IntradayV21DatasetTest(unittest.TestCase):
    def test_builds_causal_dual_head_samples_at_supported_times(self):
        builder = load_builder()
        source = panel()
        signal_index = source["trade_time"].tolist().index(
            "2026-08-10 10:00:00"
        )
        source["high"][signal_index + 2] = 10.05
        source["high"][signal_index + 8] = 10.10

        samples = builder.make_intraday_v21_samples(
            source,
            sequence_length=12,
            minimum_bars_per_day=40,
        )

        as_of = samples["as_of"].tolist()
        self.assertIn("2026-08-10 10:00:00", as_of)
        self.assertIn("2026-08-10 11:30:00", as_of)
        self.assertIn("2026-08-10 14:30:00", as_of)
        self.assertNotIn("2026-08-10 14:35:00", as_of)
        self.assertEqual(samples["X"].shape[1:], (12, 6))
        self.assertEqual(len(samples["y_next30m"]), len(as_of))
        self.assertEqual(len(samples["y_session_close"]), len(as_of))

        index = as_of.index("2026-08-10 10:00:00")
        self.assertEqual(samples["y_next30m"][index], 1)
        self.assertEqual(samples["y_session_close"][index], 1)

    def test_noon_sample_enters_at_first_afternoon_bar(self):
        builder = load_builder()
        source = panel()

        samples = builder.make_intraday_v21_samples(
            source,
            sequence_length=12,
            minimum_bars_per_day=40,
        )

        index = samples["as_of"].tolist().index("2026-08-10 11:30:00")
        self.assertEqual(samples["session_bucket"][index], "noon")
        self.assertEqual(samples["entry_time"][index], "2026-08-10 13:05:00")

    def test_rejects_signal_time_after_last_supported_30m_window(self):
        builder = load_builder()
        source = panel()

        samples = builder.make_intraday_v21_samples(
            source,
            sequence_length=12,
            minimum_bars_per_day=40,
        )

        self.assertTrue(
            all(value[11:16] <= "14:30" for value in samples["as_of"])
        )

    def test_dataset_builder_skips_codes_with_only_empty_month_caches(self):
        builder = load_builder()
        minute_data = load_minute_data()
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        start = datetime(2026, 8, 1, 9, 30)
        end = datetime(2026, 8, 31, 15, 0)

        empty_path = minute_data.month_cache_path(
            temp.name,
            "5min",
            "000001.SZ",
            start,
        )
        minute_data.write_month_cache(
            empty_path,
            frequency="5min",
            code="000001.SZ",
            start=start,
            end=end,
            rows=[],
        )

        source = panel()
        valid_path = minute_data.month_cache_path(
            temp.name,
            "5min",
            "600519.SH",
            start,
        )
        minute_data.write_month_cache(
            valid_path,
            frequency="5min",
            code="600519.SH",
            start=start,
            end=end,
            rows=[
                {
                    "ts_code": "600519.SH",
                    "trade_time": source["trade_time"][index],
                    "open": source["open"][index],
                    "high": source["high"][index],
                    "low": source["low"][index],
                    "close": source["close"][index],
                    "vol": source["vol"][index],
                    "amount": source["amount"][index],
                }
                for index in range(len(source["trade_time"]))
            ],
        )

        dataset = builder.build_dataset_from_cache(
            temp.name,
            sequence_length=12,
            minimum_bars_per_day=40,
        )

        self.assertGreater(len(dataset["X"]), 0)
        self.assertEqual(np.unique(dataset["codes"]).tolist(), ["600519.SH"])


if __name__ == "__main__":
    unittest.main()
