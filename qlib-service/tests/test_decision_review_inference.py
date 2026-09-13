import unittest

import numpy as np

from decision_engine.heads.review_contract import (
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
)
from decision_engine.review_inference import predict_review_items
from decision_engine.review_registry import REVIEW_MODEL_SCHEMA_VERSION
from decision_engine.review_registry import (
    REVIEW_ENTRY_TIMING,
    REVIEW_OBSERVATION_DURATION_MS,
    REVIEW_OBSERVATION_POLICY_VERSION,
)


class FakeModel:
    def __init__(self, value):
        self.value = value

    def predict(self, matrix):
        return np.full(len(matrix), self.value, dtype=np.float64)


def request_item():
    return {
        "schemaVersion": FEATURE_SCHEMA_VERSION,
        "asOf": 1789298000000,
        "code": "600519",
        "formulaId": "TRIGGER_REVIEW",
        "factors": {name: 1.0 for name in FEATURE_NAMES},
    }


def metadata(**overrides):
    member = {
        "seed": 42,
        "activeFeatures": list(range(len(FEATURE_NAMES))),
        "pWinCalibration": {
            "method": "isotonic",
            "x": [0.0, 0.5, 1.0],
            "y": [0.6, 0.6, 0.6],
            "sampleCount": 100,
        },
        "q10CalibrationOffset": 0.0,
    }
    return {
        "schemaVersion": REVIEW_MODEL_SCHEMA_VERSION,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureNames": list(FEATURE_NAMES),
        "predictionContract": "trigger-review-action-value.v1",
        "modelVersion": "review-test-v1",
        "observationPolicy": {
            "schemaVersion": REVIEW_OBSERVATION_POLICY_VERSION,
            "durationMs": REVIEW_OBSERVATION_DURATION_MS,
            "entryTiming": REVIEW_ENTRY_TIMING,
        },
        "ensembleSize": 2,
        "ensembleMembers": [member, {**member, "seed": 7}],
        "calibrationSampleCount": 200,
        "risk": {"expectedShortfall10": -1.2},
        "productionEligible": True,
        "baselineSelected": True,
        **overrides,
    }


def models():
    member = {
        "pWinGivenFill": FakeModel(0.0),
        "winPayoffR": FakeModel(1.5),
        "lossPayoffR": FakeModel(-0.5),
        "netRLower10": FakeModel(0.1),
    }
    return {"ensemble": [member, member]}


class ReviewInferenceTests(unittest.TestCase):
    def test_promoted_review_model_returns_standard_action_value(self):
        result = predict_review_items(
            {"items": [request_item()]},
            models=models(),
            metadata=metadata(),
        )[0]

        self.assertEqual(result["state"], "READY")
        self.assertEqual(result["usagePolicy"], "DIRECT")
        self.assertEqual(result["pFill"], 1.0)
        self.assertAlmostEqual(result["pWinGivenFill"], 0.6)
        self.assertAlmostEqual(result["expectedNetR"], 0.7)
        self.assertAlmostEqual(result["netRLowerBound"], 0.1)
        self.assertEqual(
            result["taskValues"]["review"]["source"],
            "TRIGGER_REVIEW_MODEL",
        )

    def test_unpromoted_review_model_fails_closed(self):
        result = predict_review_items(
            {"items": [request_item()]},
            models=models(),
            metadata=metadata(productionEligible=False),
        )[0]

        self.assertEqual(result["state"], "NOT_READY")
        self.assertEqual(result["reason"], "REVIEW_MODEL_NOT_PROMOTED")

    def test_legacy_short_observation_model_fails_closed(self):
        legacy = metadata()
        legacy.pop("observationPolicy")
        result = predict_review_items(
            {"items": [request_item()]},
            models=models(),
            metadata=legacy,
        )[0]

        self.assertEqual(result["state"], "NOT_READY")
        self.assertEqual(result["reason"], "REVIEW_MODEL_INVALID")

    def test_review_request_rejects_feature_contract_drift(self):
        invalid = request_item()
        invalid["factors"].pop(FEATURE_NAMES[-1])
        with self.assertRaisesRegex(ValueError, "字段不匹配"):
            predict_review_items(
                {"items": [invalid]},
                models=models(),
                metadata=metadata(),
            )


if __name__ == "__main__":
    unittest.main()
