import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from decision_engine.training.ensemble_evaluation import (  # noqa: E402
    empirical_percentiles,
    ensemble_fold,
    ensemble_eligibility,
    pwin_calibration_comparison,
)
from decision_engine.training.ensemble import (  # noqa: E402
    compact_poc_report,
    select_ensemble_blend,
)


def fold(seed_shift):
    action = {
        "fold": 1,
        "metadata": {"validationStartDate": "2026-01-01"},
        "_selection": {
            "validation": [2, 3],
            "calibration": [0, 1],
            "expectedNetR": [0.1 + seed_shift, 0.3 + seed_shift],
            "calibrationExpectedNetR": [
                0.0 + seed_shift,
                0.2 + seed_shift,
            ],
            "calibratedPWin": [0.4 + seed_shift, 0.6],
            "globalCalibratedPWin": [0.3 + seed_shift, 0.5],
        },
    }
    ranking = {
        "fold": 1,
        "metadata": {"validationStartDate": "2026-01-01"},
        "_selection": {
            "validation": [2, 3],
            "calibration": [0, 1],
            "rankerScore": [20 + seed_shift, 10 + seed_shift],
            "calibrationRankerScore": [
                0 + seed_shift,
                10 + seed_shift,
            ],
            "rankExpectedNetR": [0.4 + seed_shift, 0.2 + seed_shift],
            "calibrationRankExpectedNetR": [
                0.1 + seed_shift,
                0.3 + seed_shift,
            ],
        },
    }
    return {"action": action, "ranking": ranking}


class DecisionSeedEnsembleTest(unittest.TestCase):
    def test_rank_scores_are_normalized_before_seed_averaging(self):
        values = empirical_percentiles(
            np.asarray([0.0, 10.0]),
            np.asarray([20.0, 5.0]),
        )

        np.testing.assert_allclose(values, [1.0, 0.5])

    def test_fold_ensemble_averages_value_heads_and_rank_percentiles(self):
        result = ensemble_fold([fold(0.0), fold(1.0)])

        np.testing.assert_allclose(
            result["action"]["_selection"]["expectedNetR"],
            [0.6, 0.8],
        )
        np.testing.assert_allclose(
            result["action"]["_selection"]["pWin"],
            [0.9, 0.6],
        )
        np.testing.assert_allclose(
            result["ranking"]["_selection"]["rankerScore"],
            [1.0, 1.0],
        )
        np.testing.assert_allclose(
            result["ranking"]["_selection"]["rankExpectedNetR"],
            [0.9, 0.7],
        )

    def test_ensemble_blend_never_selects_negative_expected_candidates(self):
        weight, trials = select_ensemble_blend(
            np.asarray([0.2, -0.3, 0.4, -0.1]),
            np.asarray([0.3, -0.2, 0.5, -0.4]),
            np.asarray([0.9, 0.8, 0.7, 0.6]),
            np.asarray([1.0, -2.0, 0.5, -1.0]),
            np.asarray([
                "2026-01-01",
                "2026-01-01",
                "2026-01-02",
                "2026-01-02",
            ]),
            np.asarray(["A", "B", "C", "D"]),
        )

        self.assertIn(weight, {0.0, 0.25, 0.5, 0.75, 1.0})
        self.assertTrue(trials)
        self.assertTrue(all(
            trial["positiveExpectedCoverage"] == 0.5
            for trial in trials
        ))

    def test_ensemble_rejects_a_negative_window_lower_bound(self):
        combination = {
            "aggregate": {"top5LowerBound": 0.1},
            "folds": [
                {
                    "ranking": {
                        "top5": {
                            "mean_net_r_at_5": 0.2,
                            "netRLowerBound": 0.05,
                        },
                    },
                },
                {
                    "ranking": {
                        "top5": {
                            "mean_net_r_at_5": 0.1,
                            "netRLowerBound": -0.01,
                        },
                    },
                },
            ],
        }

        self.assertFalse(ensemble_eligibility(combination))

    def test_pwin_comparison_reports_stratified_brier_delta(self):
        dataset = {
            "y_win": np.asarray([0.0, 1.0]),
        }
        action_folds = [{
            "fold": 1,
            "_selection": {
                "validation": [0, 1],
                "globalPWin": [0.4, 0.6],
                "pWin": [0.2, 0.8],
            },
        }]

        result = pwin_calibration_comparison(
            dataset,
            action_folds,
        )

        self.assertLess(result["aggregate"]["brierDelta"], 0)

    def test_compact_poc_report_drops_daily_return_details(self):
        compact = compact_poc_report({
            "schemaVersion": "test",
            "seeds": [42, 7, 2026],
            "decision": {"eligible": False},
            "combination": {
                "aggregate": {"top5LowerBound": 0.1},
                "folds": [{
                    "fold": 1,
                    "validationStartDate": "2026-01-01",
                    "validationEndDate": "2026-01-31",
                    "positiveExpectedCoverage": 0.1,
                    "rankBlendWeight": 0.5,
                    "ranking": {
                        "top5": {
                            "mean_net_r_at_5": 0.2,
                            "netRLowerBound": 0.1,
                            "daily_net_r": {"2026-01-01": 1.0},
                        },
                    },
                }],
            },
        })

        self.assertEqual(compact["aggregate"]["top5LowerBound"], 0.1)
        self.assertEqual(compact["folds"][0]["meanNetRAt5"], 0.2)
        self.assertNotIn("ranking", compact["folds"][0])


if __name__ == "__main__":
    unittest.main()
