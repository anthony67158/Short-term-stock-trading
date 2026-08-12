import importlib.util
import os
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
MODULE_PATH = os.path.join(HERE, "..", "intraday_v21_gate.py")


def load_gate():
    spec = importlib.util.spec_from_file_location(
        "intraday_v21_gate",
        MODULE_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def head(accuracy=0.60, f1=0.52, loss=0.90):
    return {
        "balanced_accuracy": accuracy,
        "macro_f1": f1,
        "log_loss": loss,
        "class_counts": {"0": 120, "1": 150, "2": 130},
    }


def metrics():
    return {
        "model_version": "v2.1-intraday",
        "heads": {
            "next30m": head(),
            "sessionClose": head(),
        },
        "sessions": {
            bucket: {
                "next30m": head(accuracy=0.55),
                "sessionClose": head(accuracy=0.54),
            }
            for bucket in ("morning", "noon", "afternoon")
        },
    }


class IntradayV21GateTest(unittest.TestCase):
    def test_accepts_only_when_both_heads_and_all_sessions_pass(self):
        gate = load_gate()

        result = gate.evaluate_v21_candidate(metrics())

        self.assertTrue(result["production_eligible"])
        self.assertEqual(result["decision"], "promote")
        self.assertEqual(result["blockers"], [])

    def test_rejects_one_weak_head_or_insufficient_class_samples(self):
        gate = load_gate()
        weak = metrics()
        weak["heads"]["next30m"]["balanced_accuracy"] = 0.57
        weak["heads"]["sessionClose"]["class_counts"]["2"] = 99

        result = gate.evaluate_v21_candidate(weak)

        self.assertFalse(result["production_eligible"])
        self.assertEqual(result["decision"], "rejected")
        self.assertTrue(any("next30m" in item for item in result["blockers"]))
        self.assertTrue(any("sessionClose" in item for item in result["blockers"]))


if __name__ == "__main__":
    unittest.main()
