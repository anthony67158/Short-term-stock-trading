import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from decision_engine.contracts import (  # noqa: E402
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
)
from decision_engine.training.release import (  # noqa: E402
    component_decision,
    compatibility_gate,
    compose_release,
)


def evaluation(**business_overrides):
    return {
        "pFill": {
            "accuracy": 0.70,
            "precision": 0.68,
            "recall": 0.66,
            "f1": 0.67,
            "brier": 0.19,
        },
        "pWinGivenFill": {
            "accuracy": 0.65,
            "precision": 0.64,
            "recall": 0.62,
            "f1": 0.63,
            "brier": 0.21,
        },
        "expectedNetR": {
            "mae": 0.50,
            "rank_correlation": 0.30,
        },
        "tailRisk": {"q10Coverage": 0.90},
        "business": {
            "mean_net_r_at_5": 0.30,
            "netRLowerBound": 0.08,
            "precision_at_5": 0.60,
            "max_drawdown_r_at_5": 0.80,
            "positiveExpectedCoverage": 0.12,
            **business_overrides,
        },
        "inference": {"msPer1000": 8.0},
    }


def metadata(version, prefix):
    calibration = {
        "pFill": {"method": "sigmoid"},
        "pWinGivenFill": {"method": "sigmoid"},
    }
    members = []
    for seed in (42, 7):
        members.append({
            "seed": seed,
            "calibration": calibration.copy(),
            "rankingCalibration": {
                "method": "empirical-cdf",
                "scoreQuantiles": [-1.0, 1.0],
            },
            "rankValueCalibration": {
                "method": "isotonic",
                "score": [-1.0, 1.0],
                "expectedNetR": [-0.5, 0.5],
            },
            "q10CalibrationOffset": -0.1,
            "rankingRelevance": {"source": prefix},
        })
    return {
        "schemaVersion": "opportunity-score.v1",
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureNames": list(FEATURE_NAMES),
        "modelVersion": version,
        "predictionContract": "opportunity-seed-ensemble.v1",
        "modelHeads": ["ensemble"],
        "ensembleSize": 2,
        "ensembleMembers": members,
        "calibration": {
            "pFill": {"method": "seed-ensemble"},
            "pWinGivenFill": {"method": "seed-ensemble"},
            "pFillSampleCount": 100,
            "pWinGivenFillSampleCount": 80,
        },
        "rankBlendWeight": 0.5,
        "rankBlendTrials": [],
        "risk": {
            "q10Coverage": 0.9,
            "expectedShortfall10": -1.2,
        },
        "ood": {
            "minimum": [-1.0] * len(FEATURE_NAMES),
            "maximum": [1.0] * len(FEATURE_NAMES),
            "maximumViolationFraction": 0.1,
        },
    }


def models(prefix):
    heads = (
        "pFill",
        "pWinGivenFill",
        "winPayoffR",
        "lossPayoffR",
        "netRLower10",
        "ranking",
    )
    return {
        "ensemble": [
            {
                head: f"{prefix}:{seed}:{head}"
                for head in heads
            }
            for seed in (42, 7)
        ],
    }


class SelectOpportunityReleaseTest(unittest.TestCase):
    def test_probability_component_requires_real_gain_without_calibration_regression(self):
        champion = evaluation()
        challenger = evaluation()
        challenger["pFill"].update({
            "accuracy": 0.701,
            "recall": 0.68,
            "f1": 0.68,
            "brier": 0.185,
        })

        decision = component_decision(
            "fillProbability",
            champion,
            challenger,
        )

        self.assertTrue(decision["improved"])
        self.assertEqual(decision["status"], "IMPROVED")
        self.assertTrue(decision["improvements"])

    def test_probability_component_is_blocked_when_accuracy_regresses(self):
        champion = evaluation()
        challenger = evaluation()
        challenger["pWinGivenFill"].update({
            "accuracy": 0.63,
            "recall": 0.66,
            "f1": 0.65,
        })

        decision = component_decision(
            "winProbability",
            champion,
            challenger,
        )

        self.assertFalse(decision["improved"])
        self.assertEqual(decision["status"], "BLOCKED")
        self.assertTrue(any(
            "准确率" in blocker
            for blocker in decision["blockers"]
        ))

    def test_whole_model_gate_accepts_small_tradeoffs_and_rejects_tail_loss(self):
        champion = evaluation()
        compatible = evaluation(
            mean_net_r_at_5=0.295,
            netRLowerBound=0.075,
            precision_at_5=0.59,
        )
        compatible["inference"]["msPer1000"] = 9.0

        self.assertTrue(
            compatibility_gate(champion, compatible)["passed"]
        )

        unsafe = evaluation(
            netRLowerBound=-0.01,
            max_drawdown_r_at_5=1.2,
        )
        result = compatibility_gate(champion, unsafe)
        self.assertFalse(result["passed"])
        self.assertTrue(any(
            "下置信界必须大于0" in blocker
            for blocker in result["blockers"]
        ))
        self.assertTrue(any(
            "最大回撤" in blocker
            for blocker in result["blockers"]
        ))

    def test_mixed_release_replaces_only_selected_heads_and_calibration(self):
        champion_meta = metadata("champion", "champion")
        challenger_meta = metadata("challenger", "challenger")
        challenger_meta["ensembleMembers"][0][
            "q10CalibrationOffset"
        ] = -0.3
        champion_models = models("champion")
        challenger_models = models("challenger")

        mixed, mixed_meta = compose_release(
            champion_models,
            champion_meta,
            challenger_models,
            challenger_meta,
            ("fillProbability", "ranking"),
        )

        self.assertEqual(
            mixed["ensemble"][0]["pFill"],
            "challenger:42:pFill",
        )
        self.assertEqual(
            mixed["ensemble"][0]["ranking"],
            "challenger:42:ranking",
        )
        self.assertEqual(
            mixed["ensemble"][0]["pWinGivenFill"],
            "champion:42:pWinGivenFill",
        )
        self.assertEqual(
            mixed_meta["ensembleMembers"][0][
                "q10CalibrationOffset"
            ],
            -0.1,
        )

    def test_win_component_copies_stratified_calibration_with_model(self):
        champion_meta = metadata("champion", "champion")
        challenger_meta = metadata("challenger", "challenger")
        stratified = {
            "method": "stratified-playbook-route",
            "global": {"method": "sigmoid"},
            "levels": ["playbookRoute"],
            "groups": {
                "playbookRoute": {
                    "RANGE_REVERSION:PULLBACK": {
                        "sampleCount": 120,
                        "logOddsOffset": 0.2,
                    },
                },
            },
        }
        challenger_meta["ensembleMembers"][0]["calibration"][
            "pWinGivenFill"
        ] = stratified

        mixed, mixed_meta = compose_release(
            models("champion"),
            champion_meta,
            models("challenger"),
            challenger_meta,
            ("winProbability",),
        )

        self.assertEqual(
            mixed["ensemble"][0]["pWinGivenFill"],
            "challenger:42:pWinGivenFill",
        )
        self.assertEqual(
            mixed_meta["ensembleMembers"][0]["calibration"][
                "pWinGivenFill"
            ],
            stratified,
        )


if __name__ == "__main__":
    unittest.main()
