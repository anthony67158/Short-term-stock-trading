import unittest
from unittest.mock import patch

import numpy as np

from decision_engine.heads.review_contract import (
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    review_price_contract,
)
from decision_engine.review_inference import predict_review_items
from decision_engine import review_registry
from decision_engine.review_registry import REVIEW_MODEL_SCHEMA_VERSION
from decision_engine.review_registry import (
    REVIEW_EXIT_POLICY_VERSION,
    REVIEW_ENTRY_TIMING,
    REVIEW_LABEL_CONTRACT_VERSION,
    REVIEW_OBSERVATION_DURATION_MS,
    REVIEW_OBSERVATION_POLICY_VERSION,
    REVIEW_PREDICTION_CONTRACT,
    REVIEW_RISK_PROFILE_VERSION,
)


class FakeModel:
    def __init__(self, value):
        self.value = value

    def predict(self, matrix):
        return np.full(len(matrix), self.value, dtype=np.float64)


def request_item():
    price_contract = review_price_contract({
        "entryPrice": 10.2,
        "stopPrice": 9.8,
        "feeRateBps": 6.1,
        "slippageBps": 5,
        "lotSize": 100,
        "tPlusOne": True,
        "exitPolicyVersion": REVIEW_EXIT_POLICY_VERSION,
        "observationPolicyVersion": REVIEW_OBSERVATION_POLICY_VERSION,
    })
    return {
        "schemaVersion": FEATURE_SCHEMA_VERSION,
        "asOf": 1789298000000,
        "code": "600519",
        "formulaId": "TRIGGER_REVIEW",
        "factors": {name: 1.0 for name in FEATURE_NAMES},
        "priceContract": price_contract["canonical"],
        "priceContractHash": price_contract["hash"],
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
        "predictionContract": REVIEW_PREDICTION_CONTRACT,
        "priceContractSchemaVersion": "review-price-contract.v1",
        "labelContractVersion": REVIEW_LABEL_CONTRACT_VERSION,
        "exitPolicyVersion": REVIEW_EXIT_POLICY_VERSION,
        "riskProfileVersion": REVIEW_RISK_PROFILE_VERSION,
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
        self.assertEqual(
            result["priceContractHash"],
            request_item()["priceContractHash"],
        )
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

    def test_incomplete_v2_metadata_fails_closed(self):
        for field in (
            "priceContractSchemaVersion",
            "labelContractVersion",
            "exitPolicyVersion",
            "riskProfileVersion",
        ):
            invalid = metadata()
            invalid.pop(field)
            result = predict_review_items(
                {"items": [request_item()]},
                models=models(),
                metadata=invalid,
            )[0]
            self.assertEqual(result["state"], "NOT_READY")
            self.assertEqual(result["reason"], "REVIEW_MODEL_INVALID")

    def test_review_request_rejects_price_contract_hash_drift(self):
        invalid = request_item()
        invalid["priceContractHash"] = "f" * 64
        with self.assertRaisesRegex(ValueError, "价格合同"):
            predict_review_items(
                {"items": [invalid]},
                models=models(),
                metadata=metadata(),
            )

    def test_review_request_rejects_feature_contract_drift(self):
        invalid = request_item()
        invalid["factors"].pop(FEATURE_NAMES[-1])
        with self.assertRaisesRegex(ValueError, "字段不匹配"):
            predict_review_items(
                {"items": [invalid]},
                models=models(),
                metadata=metadata(),
            )

    def test_failed_hot_reload_keeps_last_complete_release(self):
        previous = (
            review_registry._MODELS,
            review_registry._META,
            review_registry._LAST_CHECK_AT,
        )
        self.addCleanup(
            setattr,
            review_registry,
            "_MODELS",
            previous[0],
        )
        self.addCleanup(
            setattr,
            review_registry,
            "_META",
            previous[1],
        )
        self.addCleanup(
            setattr,
            review_registry,
            "_LAST_CHECK_AT",
            previous[2],
        )
        current_models = models()
        current_metadata = metadata()
        review_registry._MODELS = current_models
        review_registry._META = current_metadata
        review_registry._LAST_CHECK_AT = 0
        with (
            patch.object(
                review_registry,
                "_download_release",
                side_effect=ValueError("incomplete release"),
            ),
            patch.object(review_registry.time, "time", return_value=1000),
        ):
            self.assertEqual(
                review_registry.get_review_models(force=True),
                (current_models, current_metadata),
            )


if __name__ == "__main__":
    unittest.main()
