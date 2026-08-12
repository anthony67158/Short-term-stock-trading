import importlib.util
import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODULE_PATH = os.path.join(SERVICE_ROOT, "intraday_v21_runtime.py")


def load_runtime():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "intraday_v21_runtime",
            MODULE_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(SERVICE_ROOT)


class IntradayV21RuntimeTest(unittest.TestCase):
    def test_formats_two_independent_probability_heads(self):
        runtime = load_runtime()

        result = runtime.format_v21_prediction(
            request={
                "request_id": "v21_20260812_1030_600519",
                "code": "600519.SH",
                "as_of": "2026-08-12 10:30:00",
                "session": "morning",
            },
            probabilities={
                "next30m": [0.2, 0.3, 0.5],
                "sessionClose": [0.4, 0.5, 0.1],
            },
            model_metadata={
                "run_id": "run-v21",
                "architecture": "transformer-dual-head",
                "sha256": "a" * 64,
            },
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["modelVersion"], "v2.1-intraday")
        self.assertEqual(result["session"], "morning")
        self.assertEqual(
            result["heads"]["next30m"]["predictedClass"],
            "TAKE_PROFIT",
        )
        self.assertEqual(
            result["heads"]["sessionClose"]["predictedClass"],
            "TIMEOUT",
        )
        self.assertEqual(
            result["heads"]["next30m"]["horizon"],
            "未来30分钟",
        )
        self.assertEqual(
            result["heads"]["sessionClose"]["horizon"],
            "截至今日收盘",
        )

    def test_rejects_invalid_probability_in_either_head(self):
        runtime = load_runtime()
        request = {
            "request_id": None,
            "code": "600519.SH",
            "as_of": "2026-08-12 10:30:00",
            "session": "morning",
        }
        metadata = {
            "run_id": "run-v21",
            "architecture": "transformer-dual-head",
            "sha256": "a" * 64,
        }

        with self.assertRaisesRegex(ValueError, "概率"):
            runtime.format_v21_prediction(
                request=request,
                probabilities={
                    "next30m": [0.2, 0.8],
                    "sessionClose": [0.4, 0.5, 0.1],
                },
                model_metadata=metadata,
            )


if __name__ == "__main__":
    unittest.main()
