import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from decision_engine.training.stability import (  # noqa: E402
    summarize_reports,
)


def report(
    *,
    data_hash="same",
    utility_mean=0.2,
    utility_lower=0.1,
    ranker_mean=0.2,
    ranker_lower=0.1,
    q10=0.9,
    pwin_skill=0.1,
    netr_skill=0.1,
    positive_coverage=0.2,
):
    return {
        "schemaVersion": "decision-model-bakeoff.v1",
        "dataset": {"sha256": data_hash},
        "families": {
            "lightgbm": {
                "aggregate": {
                    "utilityTop5MeanNetR": utility_mean,
                    "utilityTop5LowerBound": utility_lower,
                    "rankerTop5MeanNetR": ranker_mean,
                    "rankerTop5LowerBound": ranker_lower,
                    "q10Coverage": q10,
                    "pWinBrierSkill": pwin_skill,
                    "netRMaeSkill": netr_skill,
                    "positiveExpectedCoverage": positive_coverage,
                },
                "folds": [{
                    "ranking": {
                        "utility": {
                            "top5": {"mean_net_r_at_5": utility_mean},
                        },
                        "ranker": {
                            "top5": {"mean_net_r_at_5": ranker_mean},
                        },
                    },
                }] * 3,
            },
        },
    }


class DecisionStabilityTest(unittest.TestCase):
    def setUp(self):
        self.paths = []

    def tearDown(self):
        for path in self.paths:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass

    def save(self, value):
        import json
        import tempfile

        handle = tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".json",
            delete=False,
            encoding="utf-8",
        )
        json.dump(value, handle)
        handle.close()
        self.paths.append(handle.name)
        return handle.name

    def test_all_seeds_must_pass_lower_bound_and_q10_calibration(self):
        paths = [
            self.save(report()),
            self.save(report(utility_lower=-0.01)),
        ]

        summary = summarize_reports(paths)

        self.assertEqual(
            summary["decision"]["state"],
            "NO_STABLE_WINNER",
        )
        self.assertEqual(
            summary["families"]["lightgbm"][
                "utilityTop5WorstSeedLowerBound"
            ],
            -0.01,
        )
        self.assertFalse(
            summary["families"]["lightgbm"][
                "productionGatePassed"
            ]
        )

    def test_single_family_can_pass_all_stability_gates(self):
        paths = [
            self.save(report()),
            self.save(report(
                utility_mean=0.15,
                utility_lower=0.05,
                q10=0.89,
            )),
        ]

        summary = summarize_reports(paths)

        self.assertEqual(summary["decision"]["state"], "STABLE_WINNER")
        self.assertEqual(summary["decision"]["winner"], "lightgbm")

    def test_production_combination_requires_lightgbm_value_and_catboost_ranker(self):
        first = report()
        first["families"]["catboost"] = {
            **first["families"]["lightgbm"],
        }
        first["combination"] = {
            "aggregate": {
                "top5MeanNetR": 0.2,
                "top5LowerBound": 0.1,
            },
            "folds": [{
                "ranking": {
                    "top5": {"mean_net_r_at_5": 0.2},
                },
            }] * 3,
        }
        second = report(utility_mean=0.15, utility_lower=0.05, q10=0.89)
        second["families"]["catboost"] = {
            **second["families"]["lightgbm"],
        }
        second["combination"] = {
            "aggregate": {
                "top5MeanNetR": 0.15,
                "top5LowerBound": 0.05,
            },
            "folds": [{
                "ranking": {
                    "top5": {"mean_net_r_at_5": 0.15},
                },
            }] * 3,
        }

        summary = summarize_reports([
            self.save(first),
            self.save(second),
        ])

        self.assertTrue(summary["combination"]["eligible"])
        self.assertEqual(
            summary["decision"]["state"],
            "PRODUCTION_COMBINATION_READY",
        )
        self.assertEqual(
            summary["decision"]["winner"],
            "lightgbm+catboost",
        )


if __name__ == "__main__":
    unittest.main()
