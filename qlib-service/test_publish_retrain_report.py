import importlib.util
import os
import sys
import types
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))


def load_publisher():
    upload_model = types.ModuleType("upload_model")
    upload_model.bucket = lambda: None
    sys.modules["upload_model"] = upload_model
    spec = importlib.util.spec_from_file_location(
        "publish_retrain_report_under_test",
        os.path.join(HERE, "publish_retrain_report.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ENV = {
    "GITHUB_RUN_ID": "123456",
    "GITHUB_RUN_NUMBER": "12",
    "GITHUB_EVENT_NAME": "workflow_dispatch",
    "GITHUB_REPOSITORY": "owner/repo",
    "GITHUB_SHA": "a" * 40,
    "RETRAIN_JOB_STATUS": "success",
    "RETRAIN_PREFLIGHT": "ok",
}


class PublishRetrainReportTest(unittest.TestCase):
    def test_incremental_wait_report_explains_both_windows(self):
        publisher = load_publisher()
        _, report = publisher.report_from({
            "decision": "skip",
            "reason": "insufficient_incremental_window",
            "adapt_n": 900,
            "adapt_dates": ["20260810", "20260811"],
            "blind_n": 1100,
            "blind_dates": ["20260812", "20260813", "20260814"],
            "required_adapt_samples": 1000,
            "required_adapt_dates": 3,
            "required_blind_samples": 1000,
            "required_blind_dates": 3,
            "champion_data_end": "20260806",
            "pending_hard_errors": {
                "eligible_n": 1125,
                "hard_error_n": 413,
                "hard_error_rate": 0.3671,
            },
        }, ENV, 1)

        self.assertIn("增量适配样本：900/1000", report["body"])
        self.assertIn("增量适配交易日：2/3", report["body"])
        self.assertIn("独立盲测样本：1100/1000", report["body"])
        self.assertIn("独立盲测交易日：3/3", report["body"])
        self.assertIn(
            "待学习五日误判：413/1125（36.71%），窗口成熟后进入加权训练",
            report["body"],
        )
        self.assertEqual(
            report["meta"]["pendingHardErrors"]["hard_error_n"],
            413,
        )

    def test_metric_report_includes_accuracy_and_calibration_gates(self):
        publisher = load_publisher()
        _, report = publisher.report_from({
            "decision": "promote",
            "champ_baseline_auc": 0.61,
            "chall_holdout_auc": 0.615,
            "champion_metrics": {
                "logloss": 0.66,
                "top_precision": 0.70,
            },
            "challenger_metrics": {
                "logloss": 0.65,
                "top_precision": 0.73,
            },
            "metric_gate": {
                "improvements": ["auc_gain", "top_precision_gain"],
            },
            "adapt_n": 1200,
            "adapt_dates": ["20260810", "20260811", "20260812"],
            "blind_n": 1300,
            "blind_dates": ["20260813", "20260814", "20260817"],
            "hard_error_mining": {
                "eligible_n": 1200,
                "hard_error_n": 400,
                "hard_error_rate": 0.3333,
                "mean_applied_multiplier": 2.4,
                "max_applied_multiplier": 2.9,
            },
        }, ENV, 1)

        self.assertIn("盲测 LogLoss：冠军 0.66 vs 挑战者 0.65", report["body"])
        self.assertIn("Top10% 精度：冠军 0.7 vs 挑战者 0.73", report["body"])
        self.assertIn("晋级增益：auc_gain、top_precision_gain", report["body"])
        self.assertIn(
            "五日目标难样本：400/1200（误判率 33.33%，平均权重×2.4，最高×2.9）",
            report["body"],
        )
        self.assertEqual(
            report["meta"]["hardErrorMining"]["hard_error_n"],
            400,
        )


if __name__ == "__main__":
    unittest.main()
