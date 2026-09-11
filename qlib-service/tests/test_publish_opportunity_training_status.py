import json
import os
import tempfile
import unittest

from publish_opportunity_training_status import (
    build_training_status,
    publish_training_status,
)


class Payload:
    def __init__(self, value):
        self.value = value

    def read(self):
        return json.dumps(self.value).encode("utf-8")


class Bucket:
    def __init__(self, manifest=None):
        self.manifest = manifest
        self.saved = {}

    def get_object(self, key):
        if not self.manifest:
            raise RuntimeError("missing")
        return Payload(self.manifest)

    def put_object(self, key, body, headers=None):
        self.saved[key] = {
            "value": json.loads(body.decode("utf-8")),
            "headers": headers,
        }


class OpportunityTrainingStatusTest(unittest.TestCase):
    def test_reports_remaining_readiness_without_fake_production(self):
        value = build_training_status({
            "state": "NOT_READY",
            "generatedAt": 123,
            "shadowEligible": False,
            "readiness": {
                "samples": 180,
                "filled_samples": 60,
                "dates": 8,
                "blockers": ["成熟候选少于1000"],
            },
        })

        self.assertEqual(value["state"], "NOT_READY")
        self.assertFalse(value["productionEligible"])
        self.assertEqual(value["readiness"]["samples"], 180)
        self.assertEqual(value["readiness"]["requirements"]["dates"], 60)

    def test_active_production_manifest_is_authoritative(self):
        value = build_training_status({
            "state": "SHADOW_READY",
            "shadowEligible": True,
            "readiness": {
                "samples": 1800,
                "filled_samples": 700,
                "dates": 80,
            },
        }, active_model={
            "modelVersion": "opportunity-score.prod",
            "shadowOnly": False,
            "productionEligible": True,
        })

        self.assertEqual(value["state"], "PRODUCTION_READY")
        self.assertTrue(value["productionEligible"])

    def test_direct_manifest_is_active_without_promotion(self):
        value = build_training_status(
            {"state": "REJECTED"},
            active_model={
                "modelVersion": "opportunity-score.direct",
                "usagePolicy": "DIRECT",
                "productionEligible": False,
            },
        )
        self.assertEqual(value["state"], "DIRECT_ACTIVE")
        self.assertFalse(value["productionEligible"])
        self.assertEqual(value["usagePolicy"], "DIRECT")

    def test_direct_ensemble_only_reports_current_combination_risk(self):
        value = build_training_status(
            {
                "state": "REJECTED",
                "seedEnsemble": {
                    "folds": [{
                        "validationStartDate": "2026-07-28",
                        "validationEndDate": "2026-09-10",
                        "meanNetRAt5": -0.056952,
                        "netRLowerBound": -0.525318,
                    }],
                    "decision": {
                        "eligible": False,
                        "reason": "三种子集成仍有负收益独立窗口",
                    },
                },
            },
            {
                "eligible": False,
                "blockers": [
                    "Top5费后净R下置信界未大于0",
                    "旧单模型回撤较差",
                ],
            },
            active_model={
                "modelVersion": "opportunity-score.ensemble3",
                "usagePolicy": "DIRECT",
                "productionEligible": False,
            },
        )

        self.assertEqual(
            value["promotionBlockers"],
            [
                "最新独立窗口（2026-07-28 至 2026-09-10）"
                " Top5费后净R -0.057R，下置信界 -0.525R",
            ],
        )

    def test_selective_release_status_records_hold_decision(self):
        value = build_training_status(
            {
                "state": "SHADOW_READY",
                "readiness": {
                    "samples": 1800,
                    "filled_samples": 700,
                    "dates": 80,
                },
            },
            {
                "schemaVersion": "opportunity-selective-release.v1",
                "action": "KEEP_CURRENT",
                "reason": "没有组成部分通过整体风险阈值",
                "championVersion": "opportunity-score.champion",
                "challengerVersion": "opportunity-score.challenger",
                "selectedVersion": None,
                "releaseMode": "NONE",
                "promotedComponents": [],
                "compatibleCombinations": 0,
                "combinationsEvaluated": 3,
                "compatibility": {
                    "passed": False,
                    "blockers": ["Top5净R下置信界必须大于0"],
                },
            },
            active_model={
                "modelVersion": "opportunity-score.champion",
                "usagePolicy": "DIRECT",
                "productionEligible": True,
            },
        )

        self.assertEqual(
            value["promotionBlockers"],
            ["Top5净R下置信界必须大于0"],
        )
        self.assertEqual(
            value["lastReleaseDecision"]["action"],
            "KEEP_CURRENT",
        )
        self.assertEqual(
            value["lastReleaseDecision"]["combinationsEvaluated"],
            3,
        )

    def test_publishes_compact_status_to_stable_oss_key(self):
        bucket = Bucket({
            "runId": "opportunity-score.prod",
            "shadowOnly": False,
            "productionEligible": True,
            "activatedAt": 456,
        })
        with tempfile.TemporaryDirectory() as directory:
            report_path = os.path.join(directory, "report.json")
            with open(report_path, "w", encoding="utf-8") as handle:
                json.dump({
                    "state": "SHADOW_READY",
                    "readiness": {
                        "samples": 1200,
                        "filled_samples": 500,
                        "dates": 70,
                    },
                }, handle)
            status = publish_training_status(bucket, report_path)

        self.assertTrue(status["productionEligible"])
        saved = bucket.saved[
            "opportunitymodel/training-status.json"
        ]
        self.assertEqual(
            saved["headers"]["Content-Type"],
            "application/json",
        )


if __name__ == "__main__":
    unittest.main()
