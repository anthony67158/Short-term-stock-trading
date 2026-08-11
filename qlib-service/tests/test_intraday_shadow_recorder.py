import importlib.util
import os
import sys
import types
import unittest
from unittest.mock import Mock, patch


HERE = os.path.dirname(os.path.abspath(__file__))
MODULE_PATH = os.path.join(HERE, "..", "intraday_shadow_recorder.py")


def load_recorder():
    spec = importlib.util.spec_from_file_location(
        "intraday_shadow_recorder",
        MODULE_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class IntradayShadowRecorderTest(unittest.TestCase):
    def test_record_contains_predictions_but_no_raw_bars(self):
        recorder = load_recorder()
        prediction = {
            "requestId": "shadow_20260810_600519",
            "code": "600519.SH",
            "asOf": "2026-08-10 15:00:00",
            "predictedClass": "TAKE_PROFIT",
            "probabilities": {
                "stopLoss": 0.2,
                "timeout": 0.1,
                "takeProfit": 0.7,
            },
            "outlook": {
                "direction": "bullish",
                "confidencePct": 70,
                "expectedBarrierReturnPct": 0.58,
            },
            "targetDefinition": {
                "entry": "nextTradingDayFirst5mOpen",
                "horizon": "nextTradingDay",
            },
            "marketContext": {
                "sessionReturnPct": 1.2,
                "momentum30mPct": 0.4,
                "realizedVolPct": 1.1,
            },
            "priceReferences": {
                "anchorType": "signalClose",
                "anchorPrice": 10,
                "supportPrice": 9.9,
                "resistancePrice": 10.1,
                "indicativeTakeProfitPrice": 10.1,
                "indicativeStopLossPrice": 9.94,
                "provisional": True,
            },
            "model": {
                "runId": "run-20260811-minute5m-v2",
                "architecture": "transformer",
                "sha256": "a" * 64,
            },
        }

        record = recorder.build_shadow_record(prediction, recorded_at=123)

        self.assertEqual(record["recordedAt"], 123)
        self.assertEqual(record["predictedClass"], "TAKE_PROFIT")
        self.assertEqual(record["outlook"]["direction"], "bullish")
        self.assertEqual(
            record["targetDefinition"]["horizon"],
            "nextTradingDay",
        )
        self.assertEqual(record["marketContext"]["sessionReturnPct"], 1.2)
        self.assertEqual(record["priceReferences"]["anchorPrice"], 10)
        self.assertNotIn("bars", record)
        self.assertNotIn("candles", record)

    def test_key_is_partitioned_by_signal_date(self):
        recorder = load_recorder()

        key = recorder.shadow_record_key(
            {
                "requestId": "shadow_20260810_600519",
                "asOf": "2026-08-10 15:00:00",
                "code": "600519.SH",
            }
        )

        self.assertEqual(
            key,
            "shadow/predictions/2026-08-10/shadow_20260810_600519.json",
        )

    def test_uses_eas_rotating_sts_provider_without_long_term_keys(self):
        recorder = load_recorder()
        provider = object()
        provider_auth = object()
        bucket = object()
        providers = types.SimpleNamespace(
            DefaultCredentialsProvider=Mock(return_value=provider)
        )
        credentials_module = types.ModuleType("alibabacloud_credentials")
        credentials_module.providers = providers
        oss2 = types.ModuleType("oss2")
        oss2.ProviderAuth = Mock(return_value=provider_auth)
        oss2.Bucket = Mock(return_value=bucket)

        with patch.dict(
            sys.modules,
            {
                "alibabacloud_credentials": credentials_module,
                "oss2": oss2,
            },
        ):
            instance = recorder.OssShadowRecorder(
                bucket_name="stock-quant-lab-123",
                expected_bucket="stock-quant-lab-123",
                endpoint="https://oss-cn-hangzhou-internal.aliyuncs.com",
            )

        providers.DefaultCredentialsProvider.assert_called_once_with()
        oss2.ProviderAuth.assert_called_once_with(provider)
        oss2.Bucket.assert_called_once_with(
            provider_auth,
            "https://oss-cn-hangzhou-internal.aliyuncs.com",
            "stock-quant-lab-123",
        )
        self.assertIs(instance.bucket, bucket)
