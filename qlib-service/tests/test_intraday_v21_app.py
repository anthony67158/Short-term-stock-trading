import importlib.util
import os
import sys
import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock

from fastapi.testclient import TestClient


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODULE_PATH = os.path.join(SERVICE_ROOT, "intraday_shadow_app.py")


def valid_payload():
    moments = []
    for day in ("2026-08-11", "2026-08-12"):
        current = datetime.strptime(f"{day} 09:35:00", "%Y-%m-%d %H:%M:%S")
        end = datetime.strptime(f"{day} 11:30:00", "%Y-%m-%d %H:%M:%S")
        while current <= end:
            moments.append(current)
            current += timedelta(minutes=5)
        current = datetime.strptime(f"{day} 13:05:00", "%Y-%m-%d %H:%M:%S")
        end = datetime.strptime(f"{day} 15:00:00", "%Y-%m-%d %H:%M:%S")
        while current <= end:
            moments.append(current)
            current += timedelta(minutes=5)
    cutoff = datetime(2026, 8, 12, 10, 30)
    moments = [value for value in moments if value <= cutoff][-60:]
    return {
        "requestId": "v21_20260812_1030_600519",
        "code": "600519.SH",
        "asOf": "2026-08-12 10:30:00",
        "bars": [{
            "tradeTime": value.strftime("%Y-%m-%d %H:%M:%S"),
            "open": 10.0,
            "high": 10.1,
            "low": 9.9,
            "close": 10.0,
            "volume": 1000.0,
        } for value in moments],
    }


def load_app():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "intraday_shadow_app",
            MODULE_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(SERVICE_ROOT)


class IntradayV21AppTest(unittest.TestCase):
    def setUp(self):
        self.module = load_app()
        self.runtime = Mock()
        self.runtime.predict.return_value = {
            "ok": True,
            "shadowOnly": False,
            "modelVersion": "v2.1-intraday",
            "requestId": "v21_20260812_1030_600519",
            "code": "600519.SH",
            "asOf": "2026-08-12 10:30:00",
            "session": "morning",
            "heads": {
                "next30m": {
                    "horizon": "未来30分钟",
                    "probabilities": {
                        "stopLoss": 0.2,
                        "timeout": 0.3,
                        "takeProfit": 0.5,
                    },
                    "predictedClass": "TAKE_PROFIT",
                },
                "sessionClose": {
                    "horizon": "截至今日收盘",
                    "probabilities": {
                        "stopLoss": 0.4,
                        "timeout": 0.5,
                        "takeProfit": 0.1,
                    },
                    "predictedClass": "TIMEOUT",
                },
            },
            "model": {
                "runId": "run-v21",
                "architecture": "transformer-dual-head",
                "sha256": "a" * 64,
            },
        }
        self.recorder = Mock()
        app = self.module.create_app(
            api_key="shadow-test-key",
            v21_runtime=self.runtime,
            v21_recorder=self.recorder,
        )
        self.client = TestClient(app)

    def test_v21_route_requires_key(self):
        response = self.client.post(
            "/predict-v2-intraday",
            json=valid_payload(),
        )

        self.assertEqual(response.status_code, 401)
        self.runtime.predict.assert_not_called()

    def test_v21_route_returns_and_records_dual_head_prediction(self):
        response = self.client.post(
            "/predict-v2-intraday",
            headers={"X-Shadow-Key": "shadow-test-key"},
            json=valid_payload(),
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["modelVersion"], "v2.1-intraday")
        self.assertEqual(set(body["heads"]), {"next30m", "sessionClose"})
        self.recorder.record.assert_called_once_with(body)


if __name__ == "__main__":
    unittest.main()
