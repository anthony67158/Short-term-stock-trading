import hashlib
import json
import os
import tempfile
import unittest

from decision_engine.heads.review_contract import (
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    REVIEW_PRICE_CONTRACT_SCHEMA_VERSION,
)
from decision_engine.review_registry import (
    REVIEW_ARTIFACT_FILENAMES,
    REVIEW_EXIT_POLICY_VERSION,
    REVIEW_ENTRY_TIMING,
    REVIEW_LABEL_CONTRACT_VERSION,
    REVIEW_MODEL_SCHEMA_VERSION,
    REVIEW_OBSERVATION_DURATION_MS,
    REVIEW_OBSERVATION_POLICY_VERSION,
    REVIEW_PREDICTION_CONTRACT,
    REVIEW_RISK_PROFILE_VERSION,
)
from upload_review_model import (
    publish_review_release,
    record_confirmation_attempt,
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
        self.headers[key] = dict(headers or {})

    def put_object(self, key, payload, headers=None):
        if (
            (headers or {}).get("x-oss-forbid-overwrite") == "true"
            and key in self.objects
        ):
            raise FileExistsError(key)
        self.order.append(key)
        self.objects[key] = bytes(payload)
        self.headers[key] = dict(headers or {})

    def get_object(self, key):
        payload = self.objects[key]

        class Response:
            def read(self):
                return payload

        return Response()


def metadata(*, eligible=True):
    missing_indices = [
        index
        for index, name in enumerate(FEATURE_NAMES)
        if name.endswith("Missing")
    ]
    member = {
        "seed": 42,
        "activeFeatures": list(range(len(FEATURE_NAMES))),
        "activeFillFeatures": list(range(len(FEATURE_NAMES))),
        "pFillCalibration": {
            "method": "isotonic",
            "x": [0.0, 1.0],
            "y": [0.3, 0.7],
        },
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
        "predictionContract": REVIEW_PREDICTION_CONTRACT,
        "priceContractSchemaVersion":
            REVIEW_PRICE_CONTRACT_SCHEMA_VERSION,
        "labelContractVersion": REVIEW_LABEL_CONTRACT_VERSION,
        "exitPolicyVersion": REVIEW_EXIT_POLICY_VERSION,
        "riskProfileVersion": REVIEW_RISK_PROFILE_VERSION,
        "modelVersion": "decision-review.1789298000.ensemble2",
        "valueHead": "DECOMPOSED",
        "observationPolicy": {
            "schemaVersion": REVIEW_OBSERVATION_POLICY_VERSION,
            "durationMs": REVIEW_OBSERVATION_DURATION_MS,
            "entryTiming": REVIEW_ENTRY_TIMING,
        },
        "ensembleSize": 2,
        "ensembleMembers": [member, {**member, "seed": 7}],
        "fillCalibrationSampleCount": 120,
        "featureSupport": {
            "schemaVersion": "review-feature-support.v1",
            "lower": [0.0] * len(FEATURE_NAMES),
            "upper": [2.0] * len(FEATURE_NAMES),
            "missingFeatureIndices": missing_indices,
            "missingPatterns": ["0" * len(missing_indices)],
            "maximumOutlierFraction": 0.2,
        },
        "confirmationAudit": {
            "schemaVersion": "review-confirmation-audit.v1",
            "selectionDataHash": "1" * 64,
            "candidateHash": "2" * 64,
            "confirmationDataHash": "3" * 64,
            "reusePolicy": "SINGLE_SELECTION",
        },
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
        self.assertEqual(
            manifest["priceContractSchemaVersion"],
            REVIEW_PRICE_CONTRACT_SCHEMA_VERSION,
        )
        self.assertEqual(
            manifest["labelContractVersion"],
            REVIEW_LABEL_CONTRACT_VERSION,
        )
        for item in manifest["files"].values():
            self.assertEqual(
                item["sha256"],
                hashlib.sha256(bucket.objects[item["key"]]).hexdigest(),
            )
            self.assertEqual(
                bucket.headers[item["key"]]["x-oss-forbid-overwrite"],
                "true",
            )

    def test_record_only_then_publish_is_idempotent_for_frozen_candidate(self):
        bucket = FakeBucket()
        with tempfile.TemporaryDirectory() as directory:
            self._write_release(directory)
            frozen = metadata()
            record_confirmation_attempt(bucket, frozen, recorded_at=123)
            manifest = publish_review_release(
                bucket,
                directory,
                activated_at=123,
            )

        self.assertEqual(
            manifest["confirmationAudit"]["candidateHash"],
            frozen["confirmationAudit"]["candidateHash"],
        )
        self.assertEqual(
            len([
                key for key in bucket.order
                if "confirmation-audits" in key
            ]),
            1,
        )

    def test_rejects_model_that_failed_production_gate(self):
        bucket = FakeBucket()
        with tempfile.TemporaryDirectory() as directory:
            self._write_release(directory, eligible=False)
            with self.assertRaisesRegex(ValueError, "未通过生产门禁"):
                publish_review_release(bucket, directory)

        self.assertEqual(len(bucket.order), 1)
        self.assertIn("confirmation-audits", bucket.order[0])
        self.assertNotIn(
            "opportunitymodel/review/manifest.json",
            bucket.objects,
        )

    def test_rejects_legacy_or_incomplete_contract_before_upload(self):
        bucket = FakeBucket()
        with tempfile.TemporaryDirectory() as directory:
            self._write_release(directory)
            metadata_path = os.path.join(
                directory,
                REVIEW_ARTIFACT_FILENAMES["meta"],
            )
            with open(metadata_path, encoding="utf-8") as handle:
                value = json.load(handle)
            value["predictionContract"] = "trigger-review-action-value.v1"
            value.pop("priceContractSchemaVersion")
            with open(metadata_path, "w", encoding="utf-8") as handle:
                json.dump(value, handle)
            with self.assertRaisesRegex(ValueError, "元数据无效"):
                publish_review_release(bucket, directory)

        self.assertEqual(bucket.order, [])

    def test_rejects_reselection_on_the_same_confirmation_data(self):
        bucket = FakeBucket()
        with tempfile.TemporaryDirectory() as directory:
            self._write_release(directory, eligible=False)
            with self.assertRaisesRegex(ValueError, "未通过生产门禁"):
                publish_review_release(bucket, directory)

            metadata_path = os.path.join(
                directory,
                REVIEW_ARTIFACT_FILENAMES["meta"],
            )
            with open(metadata_path, encoding="utf-8") as handle:
                value = json.load(handle)
            value["modelVersion"] = "decision-review.second.ensemble2"
            value["confirmationAudit"]["candidateHash"] = "4" * 64
            value["productionEligible"] = True
            with open(metadata_path, "w", encoding="utf-8") as handle:
                json.dump(value, handle)

            with self.assertRaisesRegex(ValueError, "已用于另一候选"):
                publish_review_release(bucket, directory)

        self.assertNotIn(
            "opportunitymodel/review/manifest.json",
            bucket.objects,
        )


if __name__ == "__main__":
    unittest.main()
