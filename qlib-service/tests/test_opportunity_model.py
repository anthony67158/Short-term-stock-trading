import hashlib
import os
import sys
import unittest
from unittest.mock import patch

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

import opportunity_model  # noqa: E402
from opportunity_contract import (  # noqa: E402
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
)
from opportunity_model import (  # noqa: E402
    predict_opportunity_items,
    validate_opportunity_manifest,
)


class FakeModel:
    def __init__(self, value):
        self.value = value

    def predict(self, X):
        return np.full(len(X), self.value, dtype=np.float64)


def item(overrides=None):
    factors = {name: 0.0 for name in FEATURE_NAMES}
    factors.update({
        "market_STANDARD": 1.0,
        "sector_ACCUMULATION": 1.0,
        "time_INTRADAY_OPEN": 1.0,
    })
    value = {
        "schemaVersion": FEATURE_SCHEMA_VERSION,
        "asOf": 1_788_320_000_000,
        "code": "600001",
        "formulaId": "INTRADAY_VWAP_PULLBACK",
        "factors": factors,
    }
    value.update(overrides or {})
    return value


def meta():
    return {
        "schemaVersion": "opportunity-score.v1",
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "modelVersion": "opportunity-score.20260902",
        "featureNames": list(FEATURE_NAMES),
        "shadowOnly": True,
        "shadowEligible": True,
        "productionEligible": False,
        "calibration": {
            "pFill": {
                "method": "sigmoid",
                "coefficient": 1.0,
                "intercept": 0.0,
            },
            "pWinGivenFill": {
                "method": "sigmoid",
                "coefficient": 1.0,
                "intercept": 0.0,
            },
            "pFillSampleCount": 400,
            "pWinGivenFillSampleCount": 300,
        },
        "risk": {
            "netRResidualLower10": -0.1,
            "expectedShortfall10": -1.2,
        },
        "ood": {
            "minimum": [-1.0] * len(FEATURE_NAMES),
            "maximum": [2.0] * len(FEATURE_NAMES),
            "maximumViolationFraction": 0.1,
        },
    }


class OpportunityModelTest(unittest.TestCase):
    def test_manifest_requires_hashed_files_under_release_prefix(self):
        run_id = "opportunity-score.20260902"
        digest = hashlib.sha256(b"x").hexdigest()
        manifest = {
            "schemaVersion": "opportunity-model-manifest.v1",
            "runId": run_id,
            "files": {
                slot: {
                    "key": (
                        f"opportunitymodel/runs/{run_id}/{filename}"
                    ),
                    "sha256": digest,
                }
                for slot, filename in {
                    "pFill": "opportunity_fill_lgb.txt",
                    "pWinGivenFill": "opportunity_win_lgb.txt",
                    "expectedNetR": "opportunity_netr_lgb.txt",
                    "meta": "opportunity_meta.json",
                }.items()
            },
        }

        self.assertEqual(
            validate_opportunity_manifest(manifest)["runId"],
            run_id,
        )
        manifest["files"]["meta"]["key"] = "../meta.json"
        with self.assertRaisesRegex(ValueError, "文件路径无效"):
            validate_opportunity_manifest(manifest)

    def test_missing_model_returns_not_ready_without_probabilities(self):
        predictions = predict_opportunity_items(
            {"items": [item()]},
            models=None,
            metadata=None,
        )

        self.assertEqual(predictions[0]["state"], "NOT_READY")
        self.assertIsNone(predictions[0]["pFill"])
        self.assertIsNone(predictions[0]["expectedNetR"])

    def test_ready_model_returns_calibrated_three_head_prediction(self):
        predictions = predict_opportunity_items(
            {"items": [item()]},
            models={
                "pFill": FakeModel(0.7),
                "pWinGivenFill": FakeModel(0.6),
                "expectedNetR": FakeModel(0.2),
            },
            metadata=meta(),
        )

        result = predictions[0]
        self.assertEqual(result["state"], "READY")
        self.assertAlmostEqual(result["pFill"], 0.7)
        self.assertAlmostEqual(result["pWinGivenFill"], 0.6)
        self.assertAlmostEqual(result["expectedNetR"], 0.2)
        self.assertAlmostEqual(result["netRLowerBound"], 0.1)
        self.assertAlmostEqual(result["expectedShortfall10"], -1.2)
        self.assertEqual(
            result["calibration"]["bucket"],
            "STANDARD:ACCUMULATION:INTRADAY_OPEN",
        )
        self.assertEqual(result["calibration"]["sampleCount"], 300)

    def test_out_of_distribution_item_fails_closed(self):
        value = item()
        for name in FEATURE_NAMES[:10]:
            value["factors"][name] = 100.0

        result = predict_opportunity_items(
            {"items": [value]},
            models={
                "pFill": FakeModel(0.9),
                "pWinGivenFill": FakeModel(0.9),
                "expectedNetR": FakeModel(1.0),
            },
            metadata=meta(),
        )[0]

        self.assertEqual(result["state"], "OUT_OF_DISTRIBUTION")
        self.assertTrue(result["outOfDistribution"])
        self.assertIsNone(result["pFill"])
        self.assertIsNone(result["expectedNetR"])

    def test_unseen_unknown_category_fails_closed(self):
        value = item()
        value["factors"]["market_STANDARD"] = 0.0
        value["factors"]["market_UNKNOWN"] = 1.0
        metadata = meta()
        unknown_index = FEATURE_NAMES.index("market_UNKNOWN")
        metadata["ood"]["maximum"][unknown_index] = 0.0

        result = predict_opportunity_items(
            {"items": [value]},
            models={
                "pFill": FakeModel(0.9),
                "pWinGivenFill": FakeModel(0.9),
                "expectedNetR": FakeModel(1.0),
            },
            metadata=metadata,
        )[0]

        self.assertEqual(result["state"], "OUT_OF_DISTRIBUTION")

    def test_loader_caches_missing_manifest_and_keeps_last_good_model(self):
        previous = (
            opportunity_model._MODELS,
            opportunity_model._META,
            opportunity_model._LAST_CHECK_AT,
        )
        self.addCleanup(setattr, opportunity_model, "_MODELS", previous[0])
        self.addCleanup(setattr, opportunity_model, "_META", previous[1])
        self.addCleanup(
            setattr,
            opportunity_model,
            "_LAST_CHECK_AT",
            previous[2],
        )
        opportunity_model._MODELS = None
        opportunity_model._META = None
        opportunity_model._LAST_CHECK_AT = 0
        with (
            patch.object(
                opportunity_model,
                "_download_release",
                return_value=None,
            ) as download,
            patch.object(
                opportunity_model,
                "_bundled_release",
                return_value=None,
            ),
            patch.object(
                opportunity_model.time,
                "time",
                return_value=1000,
            ),
        ):
            self.assertEqual(
                opportunity_model.get_opportunity_models(),
                (None, None),
            )
            self.assertEqual(
                opportunity_model.get_opportunity_models(),
                (None, None),
            )
            download.assert_called_once()

        current_models = {"pFill": FakeModel(0.5)}
        current_meta = {"modelVersion": "current"}
        opportunity_model._MODELS = current_models
        opportunity_model._META = current_meta
        opportunity_model._LAST_CHECK_AT = 0
        with (
            patch.object(
                opportunity_model,
                "_download_release",
                return_value=None,
            ),
            patch.object(
                opportunity_model,
                "_bundled_release",
                return_value=None,
            ),
            patch.object(
                opportunity_model.time,
                "time",
                return_value=2000,
            ),
        ):
            self.assertEqual(
                opportunity_model.get_opportunity_models(force=True),
                (current_models, current_meta),
            )


if __name__ == "__main__":
    unittest.main()
