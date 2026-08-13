import os
import sys
import tempfile
import unittest
from unittest import mock

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

import collect_strategy_raw_panel as collector
from collect_strategy_raw_panel import (
    build_raw_panel,
    collect_raw_panels,
    prediction_codes,
)


class FakeClient:
    def __init__(self):
        self.calls = []

    def daily(self, code, start_date=None, end_date=None, fields=""):
        self.calls.append(("daily", code, start_date, end_date))
        return [
            {
                "trade_date": "20260106",
                "open": 10.1,
                "high": 10.4,
                "low": 10.0,
                "close": 10.3,
                "vol": 1200,
                "amount": 12500,
            },
            {
                "trade_date": "20260105",
                "open": 10.0,
                "high": 10.2,
                "low": 9.9,
                "close": 10.1,
                "vol": 1000,
                "amount": 10100,
            },
        ]

    def daily_basic(
        self,
        ts_code=None,
        start_date=None,
        end_date=None,
        fields="",
    ):
        self.calls.append(("daily_basic", ts_code, start_date, end_date))
        return [{
            "trade_date": "20260106",
            "turnover_rate_f": 3.2,
            "volume_ratio": 1.5,
        }]

    def moneyflow(
        self,
        ts_code=None,
        start_date=None,
        end_date=None,
        fields="",
    ):
        self.calls.append(("moneyflow", ts_code, start_date, end_date))
        return [{
            "trade_date": "20260105",
            "net_mf_amount": 88.0,
        }]


class BuildRawPanelTest(unittest.TestCase):
    def test_aligns_optional_sources_to_raw_daily_dates_and_declares_units(self):
        client = FakeClient()

        panel = build_raw_panel(
            "600001.SH",
            client.daily("600001.SH"),
            client.daily_basic(ts_code="600001.SH"),
            client.moneyflow(ts_code="600001.SH"),
            requested_start="20260101",
            requested_end="20260131",
        )

        self.assertEqual(panel["dates"].tolist(), ["20260105", "20260106"])
        self.assertEqual(panel["c"].tolist(), [10.1, 10.3])
        self.assertTrue(np.isnan(panel["b_volume_ratio"][0]))
        self.assertEqual(panel["b_volume_ratio"][1], 1.5)
        self.assertEqual(panel["m_net_mf_amount"][0], 88.0)
        self.assertTrue(np.isnan(panel["m_net_mf_amount"][1]))
        self.assertEqual(str(panel["price_adjustment"]), "RAW")
        self.assertEqual(str(panel["volume_unit"]), "HANDS")
        self.assertEqual(str(panel["amount_unit"]), "THOUSAND_CNY")


class CollectRawPanelsTest(unittest.TestCase):
    def test_extracts_codes_and_resumes_completed_request_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            predictions = os.path.join(directory, "predictions.npz")
            np.savez_compressed(
                predictions,
                codes=np.array(["600001.SH", "000001.SZ", "600001.SH"]),
                dates=np.array(["20260105", "20260105", "20260106"]),
                score=np.array([0.7, 0.8, 0.9]),
            )
            self.assertEqual(
                prediction_codes(predictions),
                ["000001.SZ", "600001.SH"],
            )
            output = os.path.join(directory, "panels")
            first_client = FakeClient()

            first = collect_raw_panels(
                first_client,
                ["600001.SH"],
                start_date="20260101",
                end_date="20260131",
                output_dir=output,
            )
            second_client = FakeClient()
            second = collect_raw_panels(
                second_client,
                ["600001.SH"],
                start_date="20260101",
                end_date="20260131",
                output_dir=output,
            )

            self.assertEqual(first["collected"], 1)
            self.assertEqual(second["skipped"], 1)
            self.assertEqual(second_client.calls, [])
            with np.load(
                os.path.join(output, "600001_SH.npz"),
                allow_pickle=False,
            ) as panel:
                self.assertEqual(str(panel["requested_start"]), "20260101")
                self.assertEqual(str(panel["requested_end"]), "20260131")

    def test_cli_maps_max_per_minute_to_tushare_client(self):
        with tempfile.TemporaryDirectory() as directory:
            predictions = os.path.join(directory, "predictions.npz")
            np.savez_compressed(
                predictions,
                codes=np.array(["600001.SH"]),
                dates=np.array(["20260105"]),
                score=np.array([0.7]),
            )
            client = FakeClient()
            with mock.patch.object(
                collector,
                "TushareClient",
                return_value=client,
            ) as client_factory:
                result = collector.main([
                    "--predictions",
                    predictions,
                    "--start",
                    "20260101",
                    "--end",
                    "20260131",
                    "--out",
                    os.path.join(directory, "panels"),
                    "--max-per-minute",
                    "12",
                ])

            self.assertEqual(result, 0)
            client_factory.assert_called_once_with(max_per_min=12)


if __name__ == "__main__":
    unittest.main()
