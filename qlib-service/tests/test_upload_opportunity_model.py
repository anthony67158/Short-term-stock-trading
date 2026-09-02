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


class FakeBucket:
    def __init__(self):
        self.objects = {}
        self.order = []

    def put_object_from_file(self, key, path, headers=None):
        self.order.append(key)
        with open(path, "rb") as handle:
            self.objects[key] = handle.read()
        self.assert_forbid = headers["x-oss-forbid-overwrite"]

    def put_object(self, key, payload):
        self.order.append(key)
        self.objects[key] = bytes(payload)


class UploadOpportunityModelTest(unittest.TestCase):
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

    def test_rejects_non_shadow_or_production_eligible_metadata(self):
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
                        "shadowEligible": False,
                        "shadowOnly": True,
                        "productionEligible": False,
                    })
                with open(path, "w", encoding="utf-8") as handle:
                    handle.write(content)

            with self.assertRaisesRegex(ValueError, "影子闸门"):
                publish_opportunity_release(bucket, directory)


if __name__ == "__main__":
    unittest.main()
