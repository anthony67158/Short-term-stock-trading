import importlib.util
import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODULE_PATH = os.path.join(SERVICE_ROOT, "intraday_candidate_gate.py")


def load_gate():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "intraday_candidate_gate",
            MODULE_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(SERVICE_ROOT)


class IntradayCandidateGateTest(unittest.TestCase):
    def setUp(self):
        self.gate = load_gate()
        self.download_report = {
            "requested_slices": 100,
            "completed_slices": 90,
            "failed_slices": [
                {
                    "error_type": "ValueError",
                    "error_message": "分钟 high 小于 open/close",
                }
            ]
            * 10,
        }
        self.bakeoff_metrics = {
            "tcn": {
                "holdout_log_loss": 0.79,
                "holdout_macro_f1": 0.40,
                "holdout_balanced_accuracy": 0.59,
                "best_epoch": 4,
            },
            "gru": {
                "holdout_log_loss": 0.77,
                "holdout_macro_f1": 0.42,
                "holdout_balanced_accuracy": 0.59,
                "best_epoch": 7,
            },
            "transformer": {
                "holdout_log_loss": 0.78,
                "holdout_macro_f1": 0.43,
                "holdout_balanced_accuracy": 0.61,
                "best_epoch": 7,
            },
        }

    def test_selects_transformer_for_shadow_validation(self):
        report = self.gate.evaluate_intraday_candidate(
            self.bakeoff_metrics,
            self.download_report,
        )

        self.assertEqual(report["selected_architecture"], "transformer")
        self.assertTrue(report["shadow_eligible"])
        self.assertFalse(report["production_eligible"])
        self.assertEqual(report["data_quality"]["coverage"], 0.9)
        self.assertEqual(report["data_quality"]["source_quality_exclusions"], 10)

    def test_rejects_unknown_download_failure_from_shadow(self):
        self.download_report["failed_slices"][0] = {
            "error_type": "RuntimeError",
            "error_message": "provider unavailable",
        }

        report = self.gate.evaluate_intraday_candidate(
            self.bakeoff_metrics,
            self.download_report,
        )

        self.assertFalse(report["shadow_eligible"])
        self.assertIn(
            "分钟下载包含非数据质量类失败，拒绝训练",
            report["shadow_blockers"],
        )
        self.assertFalse(report["production_eligible"])

    def test_rejects_metrics_below_shadow_thresholds(self):
        self.bakeoff_metrics["transformer"]["holdout_macro_f1"] = 0.41

        report = self.gate.evaluate_intraday_candidate(
            self.bakeoff_metrics,
            self.download_report,
        )

        self.assertFalse(report["shadow_eligible"])
        self.assertTrue(
            any("Macro F1" in blocker for blocker in report["shadow_blockers"])
        )
