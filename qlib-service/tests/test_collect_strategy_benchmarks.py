import os
import sys
import tempfile
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from collect_strategy_benchmarks import (
    collect_benchmarks,
    prediction_dates,
)


class FakeClient:
    def __init__(self, missing=None):
        self.missing = missing
        self.calls = []

    def index_daily(self, ts_code, start_date=None, end_date=None):
        self.calls.append((ts_code, start_date, end_date))
        rows = [
            {"trade_date": "20260105", "close": 100},
            {"trade_date": "20260106", "close": 101},
        ]
        return [
            row for row in rows
            if row["trade_date"] != self.missing
        ]


class CollectStrategyBenchmarksTest(unittest.TestCase):
    def test_collects_only_complete_expected_prediction_dates(self):
        client = FakeClient()

        payload = collect_benchmarks(
            client,
            ["20260105", "20260106"],
            {"CSI300": "000300.SH", "CSI1000": "000852.SH"},
        )

        self.assertEqual(payload["schemaVersion"], "strategy-benchmarks.v1")
        self.assertEqual(
            payload["benchmarks"]["CSI300"],
            {"20260105": 100.0, "20260106": 101.0},
        )
        self.assertEqual(client.calls, [
            ("000300.SH", "20260105", "20260106"),
            ("000852.SH", "20260105", "20260106"),
        ])

    def test_rejects_benchmark_with_missing_prediction_date(self):
        with self.assertRaisesRegex(ValueError, "missing dates"):
            collect_benchmarks(
                FakeClient(missing="20260106"),
                ["20260105", "20260106"],
                {"CSI300": "000300.SH"},
            )

    def test_reads_unique_sorted_dates_from_prediction_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "predictions.npz")
            np.savez_compressed(
                path,
                dates=np.array(["20260106", "20260105", "20260106"]),
                codes=np.array(["A", "A", "B"]),
                score=np.array([0.1, 0.2, 0.3]),
            )

            self.assertEqual(
                prediction_dates(path),
                ["20260105", "20260106"],
            )


if __name__ == "__main__":
    unittest.main()
