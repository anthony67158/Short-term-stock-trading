import hashlib
import io
import json
import os
import sys
import tempfile
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from download_opportunity_release import (  # noqa: E402
    download_active_release,
)
from opportunity_contract import (  # noqa: E402
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
)


class FakeBucket:
    def __init__(self, objects):
        self.objects = objects

    def get_object(self, key):
        return io.BytesIO(self.objects[key])


def release_objects():
    run_id = "opportunity-score.production"
    prefix = f"opportunitymodel/runs/{run_id}/"
    metadata = {
        "schemaVersion": "opportunity-score.v1",
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "modelVersion": run_id,
        "featureNames": list(FEATURE_NAMES),
        "predictionContract": "opportunity-seed-ensemble.v1",
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
    }
    files = {
        "ensemble": (
            "opportunity_seed_ensemble.json",
            json.dumps({
                "schemaVersion":
                    "opportunity-seed-ensemble-artifact.v1",
                "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
                "members": [],
            }).encode(),
        ),
        "meta": (
            "opportunity_meta.json",
            json.dumps(metadata).encode(),
        ),
    }
    manifest = {
        "schemaVersion": "opportunity-model-manifest.v1",
        "runId": run_id,
        "predictionContract": "opportunity-seed-ensemble.v1",
        "files": {
            slot: {
                "key": prefix + filename,
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
            for slot, (filename, payload) in files.items()
        },
    }
    objects = {
        "opportunitymodel/manifest.json":
            json.dumps(manifest).encode(),
    }
    for filename, payload in files.values():
        objects[prefix + filename] = payload
    return objects, manifest


class DownloadOpportunityReleaseTest(unittest.TestCase):
    def test_downloads_manifest_files_and_verifies_hashes(self):
        objects, manifest = release_objects()
        with tempfile.TemporaryDirectory() as directory:
            result = download_active_release(
                FakeBucket(objects),
                directory,
            )

            self.assertEqual(result["runId"], manifest["runId"])
            self.assertTrue(os.path.isfile(os.path.join(
                directory,
                "opportunity_seed_ensemble.json",
            )))
            self.assertTrue(os.path.isfile(os.path.join(
                directory,
                "opportunity_meta.json",
            )))

    def test_hash_mismatch_fails_without_installing_partial_release(self):
        objects, _ = release_objects()
        key = next(
            key
            for key in objects
            if key.endswith("opportunity_seed_ensemble.json")
        )
        objects[key] = b"corrupt"
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "摘要不匹配"):
                download_active_release(
                    FakeBucket(objects),
                    directory,
                )
            self.assertFalse(os.path.exists(os.path.join(
                directory,
                "opportunity_seed_ensemble.json",
            )))


if __name__ == "__main__":
    unittest.main()
