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


class IntradayShadowAppTest(unittest.TestCase):
    def setUp(self):
        self.module = load_app()
        self.runtime = Mock()
        self.runtime.predict.return_value = {
            "ok": True,
            "shadowOnly": True,
            "requestId": "shadow_20260810_600519",
            "code": "600519.SH",
            "asOf": "2026-08-10 15:00:00",
            "model": {
                "runId": "run-20260811-minute5m-v2",
                "architecture": "transformer",
                "sha256": "a" * 64,
            },
            "probabilities": {
                "stopLoss": 0.2,
                "timeout": 0.1,
                "takeProfit": 0.7,
            },
            "predictedClass": "TAKE_PROFIT",
            "note": "实验影子预测，不构成交易动作或生产建议",
        }
        self.recorder = Mock()
        app = self.module.create_app(
            runtime=self.runtime,
            api_key="shadow-test-key",
            recorder=self.recorder,
        )
        self.client = TestClient(app)

    def test_requires_the_independent_shadow_key(self):
        response = self.client.post("/predict-v2", json=valid_payload())

        self.assertEqual(response.status_code, 401)
        self.runtime.predict.assert_not_called()

    def test_returns_and_records_a_non_actionable_prediction(self):
        response = self.client.post(
            "/predict-v2",
            headers={"X-Shadow-Key": "shadow-test-key"},
            json=valid_payload(),
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["shadowOnly"])
        self.assertNotIn("action", body)
        self.assertNotIn("decision", body)
        self.recorder.record.assert_called_once_with(body)

    def test_rejects_invalid_input_without_running_the_model(self):
        payload = valid_payload()
        payload["bars"][-1]["high"] = 1

        response = self.client.post(
            "/predict-v2",
            headers={"X-Shadow-Key": "shadow-test-key"},
            json=payload,
        )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "INVALID_INPUT")
        self.runtime.predict.assert_not_called()
