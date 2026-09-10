import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from publish_model_retrain_report import build_report, read_report


ENV = {
    "GITHUB_RUN_ID": "123456",
    "GITHUB_RUN_NUMBER": "20",
    "GITHUB_REPOSITORY": "owner/repo",
    "GITHUB_EVENT_NAME": "schedule",
    "RETRAIN_JOB_STATUS": "success",
}


def sample(state="REJECTED"):
    return {
        "state": state,
        "generatedAt": 1_788_999_640,
        "modelVersion": "opportunity-score.test",
        "readiness": {"samples": 73004, "filled_samples": 37516, "dates": 124},
        "shadowEligible": state == "SHADOW_READY",
        "shadowBlockers": ["滚动时间窗不稳定"],
        "metrics": {"ranking": {
            "challenger": {"mean_net_r_at_5": -0.213379, "netRLowerBound": -0.518984,
                           "precision_at_5": 0.242105, "max_drawdown_r_at_5": 4.8656},
            "baseline": {"mean_net_r_at_5": -0.664453, "precision_at_5": 0.073684},
        }},
        "walkForward": {"folds": 3, "results": [{"shadowEligible": True}, {}, {}]},
        "split": {"train_end_date": "2026-06-30", "holdout_start_date": "2026-08-11"},
    }


class PublishModelRetrainReportTest(unittest.TestCase):
    def test_v3_records_negative_expectation_and_sample_counts(self):
        key, report = build_report("opportunity", sample(), {
            "eligible": False, "blockers": ["净R下界未大于0"],
        }, env=ENV, now_ms=2_000_000_000_000)
        self.assertEqual(key, "quantreport/opportunity-123456.json")
        self.assertEqual(report["decision"], "reject")
        self.assertEqual(report["meta"]["trainingAt"], 1_788_999_640_000)
        self.assertIn("73004", report["body"])
        self.assertEqual(report["details"]["metrics"][0]["challenger"], -0.213379)
        self.assertEqual(report["details"]["metrics"][1]["baseline"], None)
        self.assertIn("滚动时间窗不稳定", report["details"]["blockers"])
        self.assertIn("净R下界未大于0", report["details"]["blockers"])

    def test_gate_pass_is_not_publication(self):
        _, report = build_report("opportunity", sample("SHADOW_READY"),
                                 {"eligible": True}, env=ENV)
        self.assertEqual(report["decision"], "error")
        _, published = build_report("opportunity", sample("SHADOW_READY"),
                                    {"eligible": True},
                                    env={**ENV, "RETRAIN_PUBLISHED": "true"})
        self.assertEqual(published["decision"], "promote")

    def test_shadow_is_not_production_and_job_failure_wins(self):
        _, report = build_report("opportunity", sample("SHADOW_READY"),
                                 {"eligible": False},
                                 env={**ENV, "RETRAIN_SHADOW_PUBLISHED": "true"})
        self.assertEqual(report["decision"], "shadow")
        _, failed = build_report("opportunity", sample(),
                                 env={**ENV, "RETRAIN_JOB_STATUS": "failure"})
        self.assertEqual(failed["decision"], "error")
        _, cancelled = build_report("opportunity",
                                    env={**ENV, "RETRAIN_JOB_STATUS": "cancelled"})
        self.assertEqual(cancelled["decision"], "cancelled")

    def test_direct_publication_is_reported_without_claiming_promotion(self):
        source = sample()
        source["seedEnsemble"] = {
            "aggregate": {
                "top5MeanNetR": 0.336083,
                "top5LowerBound": 0.104692,
            },
            "decision": {
                "eligible": False,
                "reason": "最新独立窗口仍为负",
            },
        }
        _, report = build_report("opportunity", source, {
            "eligible": False, "blockers": ["净R下界未大于0"],
        }, env={**ENV, "RETRAIN_DIRECT_PUBLISHED": "true"})
        self.assertEqual(report["decision"], "updated")
        self.assertIn("不代表通过晋级", report["summary"])
        self.assertEqual(report["details"]["metrics"][0]["challenger"], 0.336083)
        self.assertTrue(any(
            value["label"] == "当前组合 Top5 净R下置信界"
            and value["challenger"] == 0.104692
            for value in report["details"]["metrics"]
        ))
        self.assertIn("净R下界未大于0", report["details"]["blockers"])
        self.assertIn("最新独立窗口仍为负", report["details"]["blockers"])

    def test_missing_report_and_not_ready_are_explicit(self):
        _, report = build_report("opportunity", env=ENV)
        self.assertEqual(report["decision"], "error")
        self.assertEqual(report["details"]["metrics"], [])
        _, pending = build_report("opportunity", {"state": "NOT_READY"}, env=ENV)
        self.assertEqual(pending["decision"], "skip")
        self.assertEqual(pending["details"]["metrics"][0]["challenger"], None)
        _, skipped = build_report("sector", env={**ENV, "RETRAIN_PREFLIGHT": "skip"})
        self.assertEqual(skipped["decision"], "skip")

    def test_sector_uses_distinct_key_and_checks_upload(self):
        source = {"promoted": True, "uploaded": False, "meta": {
            "n_samples": 10000, "blind_dates": ["20260901", "20260908"],
            "trained_at": 1_788_999_640,
            "challenger_metrics": {"next": {"auc": 0.61, "top5_precision": 0.7}},
        }}
        key, report = build_report("sector", source, env=ENV)
        self.assertEqual(key, "quantreport/sector-123456.json")
        self.assertEqual(report["decision"], "error")
        _, report = build_report("sector", {**source, "uploaded": True}, env=ENV)
        self.assertEqual(report["decision"], "promote")
        self.assertEqual(report["details"]["metrics"][0]["challenger"], 0.61)

    def test_nonfinite_metrics_do_not_become_zero_or_invalid_json(self):
        source = sample()
        source["metrics"]["ranking"]["challenger"]["netRLowerBound"] = float("nan")
        _, report = build_report("opportunity", source, env=ENV)
        self.assertIsNone(report["details"]["metrics"][1]["challenger"])
        json.dumps(report, allow_nan=False)

    def test_partial_or_missing_json_does_not_silently_claim_success(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "report.json"
            self.assertIsNone(read_report(path))
            path.write_text('{"state":', encoding="utf-8")
            self.assertIsNone(read_report(path))
            path.write_text('{"state":"NOT_READY"}', encoding="utf-8")
            self.assertEqual(read_report(path), {"state": "NOT_READY"})


if __name__ == "__main__":
    unittest.main()
