import hashlib
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from opportunity_contract import (  # noqa: E402
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
)
from upload_opportunity_model import (  # noqa: E402
    ARTIFACT_FILENAMES,
    publish_opportunity_release,
)
from opportunity_model import (  # noqa: E402
    ENSEMBLE_ARTIFACT_FILENAMES,
    ENSEMBLE_PREDICTION_CONTRACT_VERSION,
    PREDICTION_CONTRACT_VERSION,
)


class FakeBucket:
    def __init__(self):
        self.objects = {}
        self.order = []
        self.headers = {}

    def put_object_from_file(self, key, path, headers=None):
        self.order.append(key)
        with open(path, "rb") as handle:
            self.objects[key] = handle.read()
        self.assert_forbid = headers["x-oss-forbid-overwrite"]

    def put_object(self, key, payload, headers=None):
        self.order.append(key)
        self.objects[key] = bytes(payload)
        self.headers[key] = dict(headers or {})


class UploadOpportunityModelTest(unittest.TestCase):
    def test_uploads_seed_ensemble_with_its_own_artifact_layout(self):
        bucket = FakeBucket()
        with tempfile.TemporaryDirectory() as directory:
            for slot, filename in ENSEMBLE_ARTIFACT_FILENAMES.items():
                content = "{}"
                if slot == "meta":
                    content = json.dumps({
                        "schemaVersion": "opportunity-score.v1",
                        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
                        "modelVersion": "opportunity-score.ensemble3",
                        "featureNames": list(FEATURE_NAMES),
                        "predictionContract":
                            ENSEMBLE_PREDICTION_CONTRACT_VERSION,
                        "modelHeads": ["ensemble"],
                        "ensembleSize": 2,
                        "ensembleMembers": [{
                            "seed": 42,
                            "calibration": {},
                            "rankingCalibration": {},
                            "rankValueCalibration": {},
                        }, {
                            "seed": 7,
                            "calibration": {},
                            "rankingCalibration": {},
                            "rankValueCalibration": {},
                        }],
                        "shadowEligible": False,
                        "shadowOnly": True,
                        "productionEligible": False,
                    })
                with open(
                    os.path.join(directory, filename),
                    "w",
                    encoding="utf-8",
                ) as handle:
                    handle.write(content)

            manifest = publish_opportunity_release(
                bucket,
                directory,
                activate_baseline=True,
            )

        self.assertEqual(
            set(manifest["files"]),
            set(ENSEMBLE_ARTIFACT_FILENAMES),
        )
        self.assertEqual(
            manifest["predictionContract"],
            ENSEMBLE_PREDICTION_CONTRACT_VERSION,
        )
        self.assertFalse(manifest["productionEligible"])

    def test_uploads_hashed_artifacts_before_atomic_manifest(self):
        bucket = FakeBucket()
        with tempfile.TemporaryDirectory() as directory:
            for slot, filename in ARTIFACT_FILENAMES.items():
                path = os.path.join(directory, filename)
                if slot == "meta":
                    content = json.dumps({
                        "schemaVersion": "opportunity-score.v1",
                        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
                        "modelVersion": "opportunity-score.20260902",
                        "featureNames": list(FEATURE_NAMES),
                        "predictionContract":
                            PREDICTION_CONTRACT_VERSION,
                        "modelHeads": [
                            name for name in ARTIFACT_FILENAMES
                            if name != "meta"
                        ],
                        "shadowEligible": True,
                        "shadowOnly": True,
                        "productionEligible": False,
                    })
                else:
                    content = f"model:{slot}"
                with open(path, "w", encoding="utf-8") as handle:
                    handle.write(content)

            manifest = publish_opportunity_release(
                bucket,
                directory,
                prefix="opportunitymodel/",
                activated_at=123,
            )

        self.assertEqual(
            bucket.order[-1],
            "opportunitymodel/manifest.json",
        )
        self.assertEqual(
            manifest["schemaVersion"],
            "opportunity-model-manifest.v1",
        )
        self.assertEqual(
            manifest["runId"],
            "opportunity-score.20260902",
        )
        for slot, item in manifest["files"].items():
            self.assertEqual(
                item["sha256"],
                hashlib.sha256(bucket.objects[item["key"]]).hexdigest(),
            )
            self.assertIn(ARTIFACT_FILENAMES[slot], item["key"])
        self.assertEqual(bucket.assert_forbid, "true")

    def test_publishes_unpromoted_weights_without_faking_qualification(self):
        bucket = FakeBucket()
        with tempfile.TemporaryDirectory() as directory:
            for slot, filename in ARTIFACT_FILENAMES.items():
                path = os.path.join(directory, filename)
                content = "{}"
                if slot == "meta":
                    content = json.dumps({
                        "schemaVersion": "opportunity-score.v1",
                        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
                        "modelVersion": "opportunity-score.20260902",
                        "featureNames": list(FEATURE_NAMES),
                        "predictionContract":
                            PREDICTION_CONTRACT_VERSION,
                        "modelHeads": [
                            name for name in ARTIFACT_FILENAMES
                            if name != "meta"
                        ],
                        "shadowEligible": False,
                        "shadowOnly": True,
                        "productionEligible": False,
                    })
                with open(path, "w", encoding="utf-8") as handle:
                    handle.write(content)

            manifest = publish_opportunity_release(bucket, directory)
            self.assertEqual(manifest["usagePolicy"], "DIRECT")
            self.assertFalse(manifest["productionEligible"])

    def test_can_activate_best_available_baseline_without_faking_gate(self):
        bucket = FakeBucket()
        with tempfile.TemporaryDirectory() as directory:
            for slot, filename in ARTIFACT_FILENAMES.items():
                content = "{}"
                if slot == "meta":
                    content = json.dumps({
                        "schemaVersion": "opportunity-score.v1",
                        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
                        "modelVersion": "opportunity-score.20260910",
                        "featureNames": list(FEATURE_NAMES),
                        "predictionContract":
                            PREDICTION_CONTRACT_VERSION,
                        "modelHeads": [
                            name for name in ARTIFACT_FILENAMES
                            if name != "meta"
                        ],
                        "shadowEligible": False,
                        "shadowOnly": True,
                        "productionEligible": False,
                    })
                with open(
                    os.path.join(directory, filename),
                    "w",
                    encoding="utf-8",
                ) as handle:
                    handle.write(content)

            manifest = publish_opportunity_release(
                bucket,
                directory,
                activate_baseline=True,
            )

        self.assertFalse(manifest["shadowOnly"])
        self.assertTrue(manifest["baselineSelected"])
        self.assertFalse(manifest["productionEligible"])

    def test_selective_release_writes_immutable_audit_before_manifest(self):
        bucket = FakeBucket()
        with tempfile.TemporaryDirectory() as directory:
            run_id = "opportunity-score.20260911.selective"
            for slot, filename in ENSEMBLE_ARTIFACT_FILENAMES.items():
                content = "{}"
                if slot == "meta":
                    content = json.dumps({
                        "schemaVersion": "opportunity-score.v1",
                        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
                        "modelVersion": run_id,
                        "featureNames": list(FEATURE_NAMES),
                        "predictionContract":
                            ENSEMBLE_PREDICTION_CONTRACT_VERSION,
                        "modelHeads": ["ensemble"],
                        "ensembleSize": 2,
                        "ensembleMembers": [{
                            "seed": 42,
                            "calibration": {},
                            "rankingCalibration": {},
                            "rankValueCalibration": {},
                        }, {
                            "seed": 7,
                            "calibration": {},
                            "rankingCalibration": {},
                            "rankValueCalibration": {},
                        }],
                        "shadowOnly": False,
                        "productionEligible": True,
                    })
                with open(
                    os.path.join(directory, filename),
                    "w",
                    encoding="utf-8",
                ) as handle:
                    handle.write(content)
            decision = {
                "schemaVersion": "opportunity-selective-release.v1",
                "action": "PUBLISH",
                "eligible": True,
                "championVersion": "opportunity-score.previous",
                "challengerVersion": "opportunity-score.challenger",
                "selectedVersion": run_id,
                "releaseMode": "PARTIAL",
                "promotedComponents": ["ranking"],
                "compatibility": {"passed": True},
            }

            manifest = publish_opportunity_release(
                bucket,
                directory,
                activate_baseline=True,
                release_decision=decision,
            )

        audit = manifest["releaseManagement"]
        self.assertEqual(audit["strategy"], "PARTIAL")
        self.assertEqual(audit["promotedComponents"], ["ranking"])
        self.assertEqual(
            bucket.order[-1],
            "opportunitymodel/manifest.json",
        )
        self.assertIn(audit["decisionKey"], bucket.objects)


if __name__ == "__main__":
    unittest.main()
