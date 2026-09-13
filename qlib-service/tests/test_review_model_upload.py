import hashlib
import json
import os
import tempfile
import unittest

from decision_engine.heads.review_contract import (
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
)
from decision_engine.review_registry import (
    REVIEW_ARTIFACT_FILENAMES,
    REVIEW_MODEL_SCHEMA_VERSION,
)
from upload_review_model import publish_review_release


class FakeBucket:
    def __init__(self):
        self.objects = {}
        self.order = []
        self.headers = {}

    def put_object_from_file(self, key, path, headers=None):
        self.order.append(key)
        with open(path, "rb") as handle:
            self.objects[key] = handle.read()
        self.headers[key] = dict(headers or {})

    def put_object(self, key, payload, headers=None):
        self.order.append(key)
        self.objects[key] = bytes(payload)
        self.headers[key] = dict(headers or {})


def metadata(*, eligible=True):
    member = {
        "seed": 42,
        "activeFeatures": list(range(len(FEATURE_NAMES))),
        "pWinCalibration": {
            "method": "isotonic",
            "x": [0.0, 1.0],
            "y": [0.2, 0.8],
        },
        "q10CalibrationOffset": 0.0,
    }
    return {
        "schemaVersion": REVIEW_MODEL_SCHEMA_VERSION,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureNames": list(FEATURE_NAMES),
        "predictionContract": "trigger-review-action-value.v1",
        "modelVersion": "decision-review.1789298000.ensemble2",
        "ensembleSize": 2,
        "ensembleMembers": [member, {**member, "seed": 7}],
        "productionEligible": eligible,
        "baselineSelected": False,
    }


class ReviewModelUploadTests(unittest.TestCase):
    def _write_release(self, directory, *, eligible=True):
        for slot, filename in REVIEW_ARTIFACT_FILENAMES.items():
            payload = (
                metadata(eligible=eligible)
                if slot == "meta"
                else {"model": "payload"}
            )
            with open(
                os.path.join(directory, filename),
                "w",
                encoding="utf-8",
            ) as handle:
                json.dump(payload, handle)

    def test_uploads_immutable_files_before_switching_manifest(self):
        bucket = FakeBucket()
        with tempfile.TemporaryDirectory() as directory:
            self._write_release(directory)
            manifest = publish_review_release(
                bucket,
                directory,
                activated_at=123,
            )

        self.assertEqual(
            bucket.order[-1],
            "opportunitymodel/review/manifest.json",
        )
        self.assertTrue(manifest["productionEligible"])
        self.assertTrue(manifest["baselineSelected"])
        for item in manifest["files"].values():
            self.assertEqual(
                item["sha256"],
                hashlib.sha256(bucket.objects[item["key"]]).hexdigest(),
            )
            self.assertEqual(
                bucket.headers[item["key"]]["x-oss-forbid-overwrite"],
                "true",
            )

    def test_rejects_model_that_failed_production_gate(self):
        bucket = FakeBucket()
        with tempfile.TemporaryDirectory() as directory:
            self._write_release(directory, eligible=False)
            with self.assertRaisesRegex(ValueError, "未通过生产门禁"):
                publish_review_release(bucket, directory)

        self.assertEqual(bucket.order, [])


if __name__ == "__main__":
    unittest.main()
