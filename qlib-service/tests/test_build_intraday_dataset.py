import importlib.util
import os
import sys
import tempfile
import unittest
from datetime import datetime

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODULE_PATH = os.path.join(SERVICE_ROOT, "build_intraday_dataset.py")


def load_builder():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "build_intraday_dataset",
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


def panel(days):
    times = []
    opens = []
    highs = []
    lows = []
    closes = []
    volumes = []
    amounts = []
    for day, bars in days:
        for time, open_, high, low, close in bars:
            times.append(f"{day} {time}")
            opens.append(open_)
            highs.append(high)
            lows.append(low)
            closes.append(close)
            volumes.append(1000.0)
            amounts.append(close * 1000.0)
    return {
        "trade_time": np.asarray(times),
        "open": np.asarray(opens),
        "high": np.asarray(highs),
        "low": np.asarray(lows),
        "close": np.asarray(closes),
        "vol": np.asarray(volumes),
        "amount": np.asarray(amounts),
    }


class IntradayTPlusOneDatasetTest(unittest.TestCase):
    def test_barrier_counts_use_json_serializable_integer_keys(self):
        builder = load_builder()

        counts = builder.barrier_counts(np.asarray([-1, 0, 1, 1], dtype=np.int8))

        self.assertEqual(counts, {-1: 1, 0: 1, 1: 2})
        self.assertTrue(all(isinstance(key, int) for key in counts))

    def test_uses_next_trading_day_open_and_path_for_the_barrier_label(self):
        builder = load_builder()
        data = panel(
            [
                (
                    "2026-07-27",
                    [
                        ("09:30:00", 10, 10, 10, 10),
                        ("09:35:00", 10, 10, 10, 10),
                        ("15:00:00", 10, 10, 10, 10),
                    ],
                ),
                (
                    "2026-07-28",
                    [
                        ("09:30:00", 10, 10, 10, 10),
                        ("09:35:00", 10, 10, 10, 10),
                        ("15:00:00", 10, 10, 10, 10),
                    ],
                ),
                (
                    "2026-07-29",
                    [
                        ("09:30:00", 10, 10.02, 9.98, 10),
                        ("09:35:00", 10, 10.12, 9.98, 10.1),
                        ("15:00:00", 10.1, 10.1, 10, 10.05),
                    ],
                ),
            ]
        )

        samples = builder.make_day_end_samples(
            data,
            sequence_length=4,
            minimum_bars_per_day=3,
            take_profit_pct=0.01,
            stop_loss_pct=0.006,
        )

        self.assertEqual(samples["X"].shape, (1, 4, 6))
        self.assertEqual(samples["dates"].tolist(), ["2026-07-28"])
        self.assertEqual(samples["entry_open"].tolist(), [10.0])
        self.assertEqual(samples["y_barrier"].tolist(), [1])
        self.assertTrue(np.isfinite(samples["X"]).all())

    def test_does_not_use_same_day_high_when_t_plus_one_path_loses(self):
        builder = load_builder()
        data = panel(
            [
                (
                    "2026-07-27",
                    [
                        ("09:30:00", 10, 10, 10, 10),
                        ("09:35:00", 10, 10, 10, 10),
                        ("15:00:00", 10, 10, 10, 10),
                    ],
                ),
                (
                    "2026-07-28",
                    [
                        ("09:30:00", 10, 10, 10, 10),
                        ("09:35:00", 10, 10, 10, 10),
                        ("15:00:00", 10, 11, 10, 10),
                    ],
                ),
                (
                    "2026-07-29",
                    [
                        ("09:30:00", 10, 10.02, 9.92, 9.95),
                        ("09:35:00", 9.95, 9.98, 9.94, 9.96),
                        ("15:00:00", 9.96, 9.98, 9.95, 9.97),
                    ],
                ),
            ]
        )

        samples = builder.make_day_end_samples(
            data,
            sequence_length=4,
            minimum_bars_per_day=3,
            take_profit_pct=0.01,
            stop_loss_pct=0.006,
        )

        self.assertEqual(samples["dates"].tolist(), ["2026-07-28"])
        self.assertEqual(samples["y_barrier"].tolist(), [-1])


class CacheDatasetBuildTest(unittest.TestCase):
    def test_builds_a_cross_sectional_dataset_from_validated_month_caches(self):
        builder = load_builder()
        minute_data = load_minute_data()
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        start = datetime(2026, 7, 1, 9, 30)
        end = datetime(2026, 7, 31, 15, 0)
        path = minute_data.month_cache_path(
            temp.name,
            "5min",
            "600519.SH",
            start,
        )
        source = panel(
            [
                (
                    "2026-07-27",
                    [
                        ("09:30:00", 10, 10, 10, 10),
                        ("09:35:00", 10, 10, 10, 10),
                        ("15:00:00", 10, 10, 10, 10),
                    ],
                ),
                (
                    "2026-07-28",
                    [
                        ("09:30:00", 10, 10, 10, 10),
                        ("09:35:00", 10, 10, 10, 10),
                        ("15:00:00", 10, 10, 10, 10),
                    ],
                ),
                (
                    "2026-07-29",
                    [
                        ("09:30:00", 10, 10.02, 9.98, 10),
                        ("09:35:00", 10, 10.12, 9.98, 10.1),
                        ("15:00:00", 10.1, 10.1, 10, 10.05),
                    ],
                ),
            ]
        )
        rows = [
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
        ]
        minute_data.write_month_cache(
            path,
            frequency="5min",
            code="600519.SH",
            start=start,
            end=end,
            rows=rows,
        )
        builder.load_month_cache = lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("dataset construction must load cache columns directly")
        )

        dataset = builder.build_dataset_from_cache(
            temp.name,
            sequence_length=4,
            minimum_bars_per_day=3,
            take_profit_pct=0.01,
            stop_loss_pct=0.006,
        )

        self.assertEqual(dataset["X"].shape, (1, 4, 6))
        self.assertEqual(dataset["codes"].tolist(), ["600519.SH"])
        self.assertEqual(dataset["y_barrier"].tolist(), [1])


if __name__ == "__main__":
    unittest.main()
