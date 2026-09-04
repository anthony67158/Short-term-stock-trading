import math
import json
import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from opportunity_contract import (  # noqa: E402
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    SCORE_SCHEMA_VERSION,
    feature_vector,
    not_ready_prediction,
    validate_score_request,
)


def item():
    return {
        "schemaVersion": FEATURE_SCHEMA_VERSION,
        "asOf": 1_788_320_000_000,
        "code": "600001",
        "formulaId": "INTRADAY_VWAP_PULLBACK",
        "factors": {
            name: float(index)
            for index, name in enumerate(FEATURE_NAMES)
        },
    }


class OpportunityContractTest(unittest.TestCase):
    def test_feature_vector_uses_manifest_order(self):
        value = item()

        vector = feature_vector(value)

        self.assertEqual(len(vector), len(FEATURE_NAMES))
        self.assertEqual(vector[0], 0.0)
        self.assertEqual(vector[-1], float(len(FEATURE_NAMES) - 1))

    def test_request_rejects_missing_extra_and_non_finite_features(self):
        missing = item()
        del missing["factors"][FEATURE_NAMES[0]]
        with self.assertRaisesRegex(ValueError, "特征字段不匹配"):
            validate_score_request({"items": [missing]})

        extra = item()
        extra["factors"]["futureReturn"] = 9.9
        with self.assertRaisesRegex(ValueError, "特征字段不匹配"):
            validate_score_request({"items": [extra]})

        non_finite = item()
        non_finite["factors"][FEATURE_NAMES[0]] = math.inf
        with self.assertRaisesRegex(ValueError, "特征必须是有限数值"):
            validate_score_request({"items": [non_finite]})

    def test_legacy_v1_inputs_fill_new_shadow_features_with_zero(self):
        with open(
            os.path.join(
                SERVICE_ROOT,
                "contracts",
                "opportunity-score-features.json",
            ),
            encoding="utf-8",
        ) as handle:
            manifest = json.load(handle)
        legacy = item()
        legacy["schemaVersion"] = "opportunity-score-feature.v1"
        for name in manifest["legacyDefaultZeroFeatures"]:
            del legacy["factors"][name]

        normalized = validate_score_request({"items": [legacy]})[0]

        self.assertEqual(
            normalized["schemaVersion"],
            FEATURE_SCHEMA_VERSION,
        )
        for name in manifest["legacyDefaultZeroFeatures"]:
            self.assertEqual(normalized["factors"][name], 0.0)

    def test_request_caps_batch_and_validates_identity(self):
        with self.assertRaisesRegex(ValueError, "1到80"):
            validate_score_request({"items": []})
        with self.assertRaisesRegex(ValueError, "股票代码无效"):
            validate_score_request({
                "items": [{**item(), "code": "bad"}],
            })
        with self.assertRaisesRegex(ValueError, "特征版本无效"):
            validate_score_request({
                "items": [{
                    **item(),
                    "schemaVersion": "other",
                }],
            })
        with self.assertRaisesRegex(ValueError, "时点必须为正数"):
            validate_score_request({
                "items": [{**item(), "asOf": 0}],
            })

    def test_not_ready_prediction_never_returns_probabilities(self):
        value = item()

        prediction = not_ready_prediction(value, "MODEL_NOT_READY")

        self.assertEqual(
            prediction["schemaVersion"],
            SCORE_SCHEMA_VERSION,
        )
        self.assertEqual(prediction["state"], "NOT_READY")
        self.assertIsNone(prediction["pFill"])
        self.assertIsNone(prediction["pWinGivenFill"])
        self.assertIsNone(prediction["expectedNetR"])


if __name__ == "__main__":
    unittest.main()
