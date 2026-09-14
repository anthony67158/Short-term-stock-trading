import unittest
from unittest.mock import patch

import numpy as np

from decision_engine.heads.review_contract import (
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    review_price_contract,
)
from decision_engine.heads.review_contract_v4 import (
    FEATURE_NAMES_V4,
    FEATURE_SCHEMA_VERSION_V4,
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


class FirstColumnModel:
    def predict(self, matrix):
        return np.asarray(matrix[:, 0], dtype=np.float64) - 1.0


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
    value_head = overrides.get("valueHead", "DECOMPOSED")
    missing_indices = [
        index
        for index, name in enumerate(FEATURE_NAMES)
        if name.endswith("Missing")
    ]
    member = {
        "seed": 42,
        "activeFeatures": list(range(len(FEATURE_NAMES))),
        "activeFillFeatures": list(range(len(FEATURE_NAMES))),
        "activeRankFeatures": list(range(len(FEATURE_NAMES))),
        "pFillCalibration": {
            "method": "isotonic",
            "x": [0.0, 0.5, 1.0],
            "y": [0.4, 0.4, 0.4],
            "sampleCount": 120,
        },
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
        "valueHead": value_head,
        "observationPolicy": {
            "schemaVersion": REVIEW_OBSERVATION_POLICY_VERSION,
            "durationMs": REVIEW_OBSERVATION_DURATION_MS,
            "entryTiming": REVIEW_ENTRY_TIMING,
        },
        "ensembleSize": 2,
        "ensembleMembers": [member, {**member, "seed": 7}],
        "ensembleQ10CalibrationOffset": 0.0,
        "selectionPolicy": {
            "schemaVersion": "review-selection-policy.v1",
            "valueHead": value_head,
            "rankingMode": "VALUE",
            "minimumPFill": 0.0,
            "minimumPWinGivenFill": 0.0,
            "minimumExpectedNetR": -10.0,
            "minimumNetRLowerBound": -10.0,
            "allowedSectorPhases": [],
        },
        "calibrationSampleCount": 200,
        "fillCalibrationSampleCount": 240,
        "featureSupport": {
            "schemaVersion": "review-feature-support.v1",
            "lower": [0.0] * len(FEATURE_NAMES),
            "upper": [2.0] * len(FEATURE_NAMES),
            "missingFeatureIndices": missing_indices,
            "missingPatterns": ["1" * len(missing_indices)],
            "maximumOutlierFraction": 0.2,
        },
        "confirmationAudit": {
            "schemaVersion": "review-confirmation-audit.v1",
            "selectionDataHash": "1" * 64,
            "candidateHash": "2" * 64,
            "confirmationDataHash": "3" * 64,
            "reusePolicy": "SINGLE_SELECTION",
        },
        "risk": {"expectedShortfall10": -1.2},
        "productionEligible": True,
        "baselineSelected": True,
        **overrides,
    }


def v4_request_item():
    value = request_item()
    value["schemaVersion"] = FEATURE_SCHEMA_VERSION_V4
    value["factors"] = {
        **value["factors"],
        **{
            name: 1.0 if name.endswith("Missing") else 0.0
            for name in FEATURE_NAMES_V4[len(FEATURE_NAMES):]
        },
    }
    return value


def v4_metadata(**overrides):
    value = metadata()
    value["featureSchemaVersion"] = FEATURE_SCHEMA_VERSION_V4
    value["featureNames"] = list(FEATURE_NAMES_V4)
    missing_indices = [
        index
        for index, name in enumerate(FEATURE_NAMES_V4)
        if name.endswith("Missing")
    ]
    value["featureSupport"] = {
        **value["featureSupport"],
        "lower": [0.0] * len(FEATURE_NAMES_V4),
        "upper": [2.0] * len(FEATURE_NAMES_V4),
        "missingFeatureIndices": missing_indices,
        "missingPatterns": ["1" * len(missing_indices)],
    }
    value["ensembleMembers"] = [
        {
            **member,
            "activeFeatures": list(range(len(FEATURE_NAMES_V4))),
            "activeFillFeatures": list(range(len(FEATURE_NAMES_V4))),
            "activeRankFeatures": list(range(len(FEATURE_NAMES_V4))),
        }
        for member in value["ensembleMembers"]
    ]
    value.update(overrides)
    return value


def models():
    member = {
        "pFill": FakeModel(0.0),
        "pWinGivenFill": FakeModel(0.0),
        "winPayoffR": FakeModel(1.5),
        "lossPayoffR": FakeModel(-0.5),
        "directNetR": FakeModel(0.9),
        "netRLower10": FakeModel(0.1),
        "opportunityRanker": FakeModel(0.0),
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
        self.assertEqual(result["pFill"], 0.4)
        self.assertEqual(
            result["priceContractHash"],
            request_item()["priceContractHash"],
        )
        self.assertAlmostEqual(result["pWinGivenFill"], 0.6)
        self.assertAlmostEqual(result["expectedNetR"], 0.7)
        self.assertAlmostEqual(result["expectedNetRGivenFill"], 0.7)
        self.assertAlmostEqual(result["expectedOpportunityR"], 0.28)
        self.assertAlmostEqual(result["netRLowerBound"], 0.1)
        self.assertEqual(result["taskValues"]["execution"]["pFill"], 0.4)
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

    def test_v4_model_accepts_full_176_feature_request(self):
        result = predict_review_items(
            {"items": [v4_request_item()]},
            models=models(),
            metadata=v4_metadata(),
        )[0]

        self.assertEqual(result["state"], "READY")
        self.assertEqual(result["usagePolicy"], "DIRECT")

    def test_v4_model_accepts_v3_request_with_neutral_alpha_during_rollout(self):
        result = predict_review_items(
            {"items": [request_item()]},
            models=models(),
            metadata=v4_metadata(),
        )[0]

        self.assertEqual(result["state"], "READY")
        self.assertEqual(result["usagePolicy"], "DIRECT")

    def test_v3_model_accepts_v4_request_during_rollout(self):
        result = predict_review_items(
            {"items": [v4_request_item()]},
            models=models(),
            metadata=metadata(),
        )[0]

        self.assertEqual(result["state"], "READY")
        self.assertEqual(result["usagePolicy"], "DIRECT")

    def test_frozen_direct_value_head_controls_confirmation_inference(self):
        result = predict_review_items(
            {"items": [request_item()]},
            models=models(),
            metadata=metadata(valueHead="DIRECT"),
        )[0]

        self.assertAlmostEqual(result["expectedNetRGivenFill"], 0.9)
        self.assertAlmostEqual(result["expectedOpportunityR"], 0.36)

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

    def test_review_model_without_fill_head_fails_closed(self):
        incomplete_models = models()
        incomplete_models["ensemble"][0].pop("pFill")

        result = predict_review_items(
            {"items": [request_item()]},
            models=incomplete_models,
            metadata=metadata(),
        )[0]

        self.assertEqual(result["state"], "NOT_READY")
        self.assertEqual(result["reason"], "REVIEW_MODEL_INVALID")

    def test_out_of_support_features_fail_closed(self):
        item = request_item()
        for name in FEATURE_NAMES[:10]:
            item["factors"][name] = 100.0

        result = predict_review_items(
            {"items": [item]},
            models=models(),
            metadata=metadata(),
        )[0]

        self.assertEqual(result["state"], "NOT_READY")
        self.assertEqual(
            result["reason"],
            "REVIEW_MODEL_OUT_OF_DISTRIBUTION",
        )
        self.assertTrue(result["outOfDistribution"])

    def test_unseen_missing_pattern_fails_closed(self):
        item = request_item()
        missing_name = next(
            name for name in FEATURE_NAMES if name.endswith("Missing")
        )
        item["factors"][missing_name] = 0.0

        result = predict_review_items(
            {"items": [item]},
            models=models(),
            metadata=metadata(),
        )[0]

        self.assertEqual(result["state"], "NOT_READY")
        self.assertTrue(result["outOfDistribution"])

    def test_q10_is_predicted_per_sample_instead_of_using_a_global_tail(self):
        first = request_item()
        second = request_item()
        first["factors"][FEATURE_NAMES[0]] = 0.5
        second["factors"][FEATURE_NAMES[0]] = 1.5
        fitted_models = models()
        for member in fitted_models["ensemble"]:
            member["netRLower10"] = FirstColumnModel()

        results = predict_review_items(
            {"items": [first, second]},
            models=fitted_models,
            metadata=metadata(),
        )

        self.assertAlmostEqual(results[0]["netRLowerBound"], -0.5)
        self.assertAlmostEqual(results[1]["netRLowerBound"], 0.5)

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
