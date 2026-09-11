import hashlib
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from decision_engine import registry  # noqa: E402
from decision_engine.contracts import (  # noqa: E402
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    feature_names_for_schema,
)
from decision_engine.inference import (  # noqa: E402
    predict_decision_items,
)
from decision_engine.registry import (  # noqa: E402
    ARTIFACT_FILENAMES,
    CatBoostJsonRanker,
    ENSEMBLE_ARTIFACT_FILENAMES,
    ENSEMBLE_PREDICTION_CONTRACT_VERSION,
    PREDICTION_CONTRACT_VERSION,
    validate_decision_metadata,
    validate_decision_manifest,
)
from decision_engine.state_encoder import (  # noqa: E402
    is_out_of_distribution,
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
    def test_catboost_json_ranker_matches_oblivious_tree_contract(self):
        payload = {
            "oblivious_trees": [{
                "splits": [{
                    "split_type": "FloatFeature",
                    "float_feature_index": 0,
                    "border": 0.5,
                }],
                "leaf_values": [-0.25, 0.75],
            }],
            "scale_and_bias": [2.0, [0.1]],
        }
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "ranker.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(payload, handle)
            model = CatBoostJsonRanker(path)

        np.testing.assert_allclose(
            model.predict(np.asarray([[0.2], [0.8]])),
            [-0.4, 1.6],
        )

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
            validate_decision_manifest(manifest)["runId"],
            run_id,
        )
        manifest["files"]["meta"]["key"] = "../meta.json"
        with self.assertRaisesRegex(ValueError, "文件路径无效"):
            validate_decision_manifest(manifest)

    def test_missing_model_returns_not_ready_without_probabilities(self):
        predictions = predict_decision_items(
            {"items": [item()]},
            models=None,
            metadata=None,
        )

        self.assertEqual(predictions[0]["state"], "NOT_READY")
        self.assertIsNone(predictions[0]["pFill"])
        self.assertIsNone(predictions[0]["expectedNetR"])

    def test_ready_model_returns_calibrated_three_head_prediction(self):
        predictions = predict_decision_items(
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
        self.assertEqual(result["usagePolicy"], "DIRECT")
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
        self.assertIsNone(result["rankingScore"])
        self.assertEqual(
            result["taskValues"]["schemaVersion"],
            "decision-task-values.v1",
        )
        self.assertAlmostEqual(
            result["taskValues"]["entry"]["expectedNetR"],
            0.14,
        )
        self.assertAlmostEqual(
            result["taskValues"]["portfolio"]["holdR"],
            0.2,
        )
        self.assertEqual(
            result["engine"]["router"],
            "action-router.tree-v1",
        )

    def test_hurdle_q10_ranker_model_composes_prediction(self):
        metadata = meta()
        metadata.update({
            "predictionContract": PREDICTION_CONTRACT_VERSION,
            "modelHeads": [
                slot for slot in ARTIFACT_FILENAMES if slot != "meta"
            ],
            "rankingCalibration": {
                "method": "empirical-cdf",
                "sampleCount": 200,
                "scoreQuantiles": [-1.0, 0.0, 1.0],
            },
            "rankValueCalibration": {
                "method": "isotonic",
                "sampleCount": 200,
                "score": [-1.0, 0.0, 1.0],
                "expectedNetR": [-0.5, 0.5, 1.5],
            },
            "rankBlendWeight": 0.5,
            "risk": {
                "q10CalibrationOffset": -0.1,
                "q10Coverage": 0.9,
                "expectedShortfall10": -1.3,
            },
        })
        result = predict_decision_items(
            {"items": [item()]},
            models={
                "pFill": FakeModel(0.7),
                "pWinGivenFill": FakeModel(0.6),
                "winPayoffR": FakeModel(2.0),
                "lossPayoffR": FakeModel(-1.0),
                "netRLower10": FakeModel(-0.4),
                "ranking": FakeModel(0.0),
            },
            metadata=metadata,
        )[0]

        self.assertEqual(result["state"], "READY")
        self.assertAlmostEqual(result["expectedNetR"], 0.65)
        self.assertAlmostEqual(result["netRLowerBound"], -0.5)
        self.assertAlmostEqual(result["expectedShortfall10"], -1.3)
        self.assertAlmostEqual(result["rankingScore"], 0.5)

    def test_hurdle_model_applies_playbook_route_win_calibration(self):
        metadata = meta()
        metadata.update({
            "predictionContract": PREDICTION_CONTRACT_VERSION,
            "modelHeads": [
                slot for slot in ARTIFACT_FILENAMES if slot != "meta"
            ],
            "rankingCalibration": {
                "method": "empirical-cdf",
                "sampleCount": 200,
                "scoreQuantiles": [-1.0, 0.0, 1.0],
            },
            "rankValueCalibration": {
                "method": "isotonic",
                "sampleCount": 200,
                "score": [-1.0, 0.0, 1.0],
                "expectedNetR": [-0.5, 0.5, 1.5],
            },
            "rankBlendWeight": 0.0,
            "risk": {
                "q10CalibrationOffset": -0.1,
                "q10Coverage": 0.9,
                "expectedShortfall10": -1.3,
            },
        })
        metadata["calibration"]["pWinGivenFill"] = {
            "method": "stratified-playbook-route",
            "global": {
                "method": "sigmoid",
                "coefficient": 1.0,
                "intercept": 0.0,
            },
            "globalSampleCount": 500,
            "levels": ["playbookRoute"],
            "groups": {
                "playbookRoute": {
                    "RANGE_REVERSION:PULLBACK": {
                        "sampleCount": 120,
                        "logOddsOffset": 1.38629436112,
                    },
                },
            },
        }
        value = item()
        value["factors"]["playbook_RANGE_REVERSION"] = 1.0
        value["factors"]["route_PULLBACK"] = 1.0

        result = predict_decision_items(
            {"items": [value]},
            models={
                "pFill": FakeModel(0.7),
                "pWinGivenFill": FakeModel(0.5),
                "winPayoffR": FakeModel(2.0),
                "lossPayoffR": FakeModel(-1.0),
                "netRLower10": FakeModel(-0.4),
                "ranking": FakeModel(0.0),
            },
            metadata=metadata,
        )[0]

        self.assertEqual(result["state"], "READY")
        self.assertAlmostEqual(result["pWinGivenFill"], 0.8)
        self.assertAlmostEqual(result["expectedNetR"], 1.4)
        self.assertEqual(
            result["calibration"]["pWinBucket"],
            "RANGE_REVERSION:PULLBACK",
        )
        self.assertEqual(
            result["calibration"]["pWinLevel"],
            "playbookRoute",
        )
        self.assertEqual(result["calibration"]["pWinSampleCount"], 120)

    def test_seed_ensemble_averages_member_predictions_before_decision(self):
        metadata = meta()
        identity = {
            "method": "sigmoid",
            "coefficient": 1.0,
            "intercept": 0.0,
        }
        rank_value = {
            "method": "isotonic",
            "sampleCount": 100,
            "score": [-1.0, 0.0, 1.0],
            "expectedNetR": [-0.5, 0.5, 1.5],
        }
        rank_calibration = {
            "method": "empirical-cdf",
            "sampleCount": 100,
            "scoreQuantiles": [-1.0, 0.0, 1.0],
        }
        metadata.update({
            "predictionContract":
                ENSEMBLE_PREDICTION_CONTRACT_VERSION,
            "modelHeads": [
                slot
                for slot in ENSEMBLE_ARTIFACT_FILENAMES
                if slot != "meta"
            ],
            "ensembleSize": 2,
            "ensembleMembers": [{
                "seed": 42,
                "calibration": {
                    "pFill": identity,
                    "pWinGivenFill": identity,
                },
                "rankingCalibration": rank_calibration,
                "rankValueCalibration": rank_value,
                "q10CalibrationOffset": 0.0,
            }, {
                "seed": 7,
                "calibration": {
                    "pFill": identity,
                    "pWinGivenFill": identity,
                },
                "rankingCalibration": rank_calibration,
                "rankValueCalibration": rank_value,
                "q10CalibrationOffset": 0.0,
            }],
            "rankBlendWeight": 0.5,
        })
        member = lambda p_fill, p_win, q10: {
            "pFill": FakeModel(p_fill),
            "pWinGivenFill": FakeModel(p_win),
            "winPayoffR": FakeModel(2.0),
            "lossPayoffR": FakeModel(-1.0),
            "netRLower10": FakeModel(q10),
            "ranking": FakeModel(0.0),
        }

        result = predict_decision_items(
            {"items": [item()]},
            models={
                "ensemble": [
                    member(0.2, 0.2, -0.4),
                    member(0.8, 0.8, -0.2),
                ],
            },
            metadata=metadata,
        )[0]

        self.assertEqual(result["state"], "READY")
        self.assertAlmostEqual(result["pFill"], 0.5)
        self.assertAlmostEqual(result["pWinGivenFill"], 0.5)
        self.assertAlmostEqual(result["expectedNetR"], 0.5)
        self.assertAlmostEqual(result["netRLowerBound"], -0.3)
        self.assertAlmostEqual(result["rankingScore"], 0.5)

    def test_v5_request_can_use_loaded_v4_model_during_cutover(self):
        metadata = meta()
        legacy_names = feature_names_for_schema(
            "opportunity-score-feature.v4",
        )
        metadata.update({
            "featureSchemaVersion": "opportunity-score-feature.v4",
            "featureNames": list(legacy_names),
            "ood": {
                "minimum": [-1.0] * len(legacy_names),
                "maximum": [2.0] * len(legacy_names),
                "maximumViolationFraction": 0.1,
            },
        })

        validate_decision_metadata(metadata)
        result = predict_decision_items(
            {"items": [item()]},
            models={
                "pFill": FakeModel(0.7),
                "pWinGivenFill": FakeModel(0.6),
                "expectedNetR": FakeModel(0.2),
            },
            metadata=metadata,
        )[0]

        self.assertEqual(result["state"], "READY")
        self.assertAlmostEqual(result["expectedNetR"], 0.2)

    def test_out_of_distribution_is_diagnostic_without_blocking_direct_use(self):
        value = item()
        for name in FEATURE_NAMES[:13]:
            value["factors"][name] = 100.0

        result = predict_decision_items(
            {"items": [value]},
            models={
                "pFill": FakeModel(0.9),
                "pWinGivenFill": FakeModel(0.9),
                "expectedNetR": FakeModel(1.0),
            },
            metadata=meta(),
        )[0]

        self.assertEqual(result["state"], "READY")
        self.assertTrue(result["outOfDistribution"])
        self.assertAlmostEqual(result["pFill"], 0.9)
        self.assertAlmostEqual(result["expectedNetR"], 1.0)

    def test_unseen_unknown_category_keeps_model_prediction_with_warning(self):
        value = item()
        value["factors"]["market_STANDARD"] = 0.0
        value["factors"]["market_UNKNOWN"] = 1.0
        metadata = meta()
        unknown_index = FEATURE_NAMES.index("market_UNKNOWN")
        metadata["ood"]["maximum"][unknown_index] = 0.0

        result = predict_decision_items(
            {"items": [value]},
            models={
                "pFill": FakeModel(0.9),
                "pWinGivenFill": FakeModel(0.9),
                "expectedNetR": FakeModel(1.0),
            },
            metadata=metadata,
        )[0]

        self.assertEqual(result["state"], "READY")
        self.assertTrue(result["outOfDistribution"])
        self.assertAlmostEqual(result["pFill"], 0.9)

    def test_supported_exploration_category_is_not_unknown_distribution(self):
        value = item()
        value["factors"]["recall_EXPLORATION"] = 1.0
        metadata = meta()
        unknown_index = FEATURE_NAMES.index("recall_UNKNOWN")
        exploration_index = FEATURE_NAMES.index("recall_EXPLORATION")
        metadata["ood"]["maximum"][unknown_index] = 0.0
        metadata["ood"]["maximum"][exploration_index] = 1.0

        self.assertFalse(is_out_of_distribution(
            [value["factors"][name] for name in FEATURE_NAMES],
            metadata,
        ))

    def test_failed_promotion_does_not_block_existing_model(self):
        metadata = meta()
        metadata["shadowEligible"] = False
        result = predict_decision_items(
            {"items": [item()]},
            models={
                "pFill": FakeModel(0.7),
                "pWinGivenFill": FakeModel(0.6),
                "expectedNetR": FakeModel(0.2),
            },
            metadata=metadata,
        )[0]
        self.assertEqual(result["state"], "READY")
        self.assertEqual(result["usagePolicy"], "DIRECT")
        self.assertFalse(result["productionEligible"])

    def test_loader_caches_missing_manifest_and_keeps_last_good_model(self):
        previous = (
            registry._MODELS,
            registry._META,
            registry._LAST_CHECK_AT,
        )
        self.addCleanup(setattr, registry, "_MODELS", previous[0])
        self.addCleanup(setattr, registry, "_META", previous[1])
        self.addCleanup(
            setattr,
            registry,
            "_LAST_CHECK_AT",
            previous[2],
        )
        registry._MODELS = None
        registry._META = None
        registry._LAST_CHECK_AT = 0
        with (
            patch.object(
                registry,
                "_download_release",
                return_value=None,
            ) as download,
            patch.object(
                registry,
                "_bundled_release",
                return_value=None,
            ),
            patch.object(
                registry.time,
                "time",
                return_value=1000,
            ),
        ):
            self.assertEqual(
                registry.get_decision_models(),
                (None, None),
            )
            self.assertEqual(
                registry.get_decision_models(),
                (None, None),
            )
            download.assert_called_once()

        current_models = {"pFill": FakeModel(0.5)}
        current_meta = {"modelVersion": "current"}
        registry._MODELS = current_models
        registry._META = current_meta
        registry._LAST_CHECK_AT = 0
        with (
            patch.object(
                registry,
                "_download_release",
                side_effect=RuntimeError("OSS unavailable"),
            ),
            patch.object(
                registry,
                "_bundled_release",
                return_value=None,
            ),
            patch.object(
                registry.time,
                "time",
                return_value=2000,
            ),
        ):
            self.assertEqual(
                registry.get_decision_models(force=True),
                (current_models, current_meta),
            )


if __name__ == "__main__":
    unittest.main()
