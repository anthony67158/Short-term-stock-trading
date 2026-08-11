import importlib.util
import os
import sys
import unittest
from datetime import datetime, timedelta


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODULE_PATH = os.path.join(SERVICE_ROOT, "intraday_shadow_contract.py")


def load_contract():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "intraday_shadow_contract",
            MODULE_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(SERVICE_ROOT)


def valid_payload():
    start = datetime(2026, 8, 10, 10, 0)
    bars = []
    for index in range(60):
        moment = start + timedelta(minutes=index * 5)
        bars.append(
            {
                "tradeTime": moment.strftime("%Y-%m-%d %H:%M:%S"),
                "open": 10.0,
                "high": 10.1,
                "low": 9.9,
                "close": 10.0,
                "volume": 1000.0,
            }
        )
    bars.append(
        {
            "tradeTime": "2026-08-10 15:00:00",
            "open": 10.0,
            "high": 10.1,
            "low": 9.9,
            "close": 10.0,
            "volume": 1000.0,
        }
    )
    return {
        "requestId": "shadow_20260810_600519",
        "code": "600519.SH",
        "asOf": "2026-08-10 15:00:00",
        "bars": bars,
    }


class IntradayShadowContractTest(unittest.TestCase):
    def test_normalizes_a_valid_day_end_request(self):
        contract = load_contract()

        request = contract.validate_predict_v2_payload(valid_payload())

        self.assertEqual(request["code"], "600519.SH")
        self.assertEqual(request["as_of"], "2026-08-10 15:00:00")
        self.assertEqual(len(request["panel"]["trade_time"]), 61)

    def test_rejects_non_day_end_input(self):
        contract = load_contract()
        payload = valid_payload()
        payload["asOf"] = "2026-08-10 14:59:00"
        payload["bars"][-1]["tradeTime"] = "2026-08-10 14:59:00"

        with self.assertRaisesRegex(ValueError, "日终"):
            contract.validate_predict_v2_payload(payload)

    def test_rejects_invalid_ohlc_or_unordered_bars(self):
        contract = load_contract()
        payload = valid_payload()
        payload["bars"][4]["high"] = 9.8

        with self.assertRaisesRegex(ValueError, "high"):
            contract.validate_predict_v2_payload(payload)

        payload = valid_payload()
        payload["bars"][5]["tradeTime"] = payload["bars"][4]["tradeTime"]
        with self.assertRaisesRegex(ValueError, "严格升序"):
            contract.validate_predict_v2_payload(payload)
