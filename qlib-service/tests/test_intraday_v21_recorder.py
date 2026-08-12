import importlib.util
import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODULE_PATH = os.path.join(SERVICE_ROOT, "intraday_v21_recorder.py")


def load_recorder():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "intraday_v21_recorder",
            MODULE_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(SERVICE_ROOT)


class IntradayV21RecorderTest(unittest.TestCase):
    def test_uses_isolated_prefix_and_excludes_raw_bars(self):
        recorder = load_recorder()
        prediction = {
            "requestId": "v21_20260812_1030_600519",
            "code": "600519.SH",
            "asOf": "2026-08-12 10:30:00",
            "session": "morning",
            "model": {"runId": "run-v21"},
            "heads": {"next30m": {}, "sessionClose": {}},
            "bars": [{"close": 10}],
        }

        record = recorder.build_v21_record(prediction, recorded_at=123)
        key = recorder.v21_record_key(record)

        self.assertEqual(record["recordedAt"], 123)
        self.assertNotIn("bars", record)
        self.assertEqual(
            key,
            "shadow/v2.1-intraday/2026-08-12/"
            "v21_20260812_1030_600519.json",
        )


if __name__ == "__main__":
    unittest.main()
