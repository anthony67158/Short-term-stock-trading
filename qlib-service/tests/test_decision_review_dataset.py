import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from decision_engine.heads.review_contract import (  # noqa: E402
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    feature_vector,
    review_price_contract,
)
from decision_engine.training.review_dataset import (  # noqa: E402
    _stress_net_r,
    build_opportunity_review_dataset,
    normalize_review_history_outcomes,
)
from decision_engine.training.review_bakeoff import (  # noqa: E402
    select_review_candidate,
)
from decision_engine.training.review_ensemble import _evaluate  # noqa: E402


def review_input():
    contract = review_price_contract({
        "entryPrice": 10.2,
        "stopPrice": 9.8,
        "feeRateBps": 6.1,
        "slippageBps": 5,
        "lotSize": 100,
        "tPlusOne": True,
        "exitPolicyVersion": "trailing-exit.v1",
        "observationPolicyVersion": "trigger-review-observation.v1",
    })
    return {
        "schemaVersion": FEATURE_SCHEMA_VERSION,
        "asOf": 1_788_320_060_000,
        "code": "600001",
        "priceContract": contract["canonical"],
        "priceContractHash": contract["hash"],
        "factors": {
            name: float(index)
            for index, name in enumerate(FEATURE_NAMES)
        },
    }


class OpportunityReviewDatasetTest(unittest.TestCase):
    def test_10bps_stress_deducts_extra_slippage_on_both_legs(self):
        stressed, available = _stress_net_r({
            "metrics": {"initialRiskCash": 100},
            "entry": {"grossAmount": 1000},
            "exit": {"grossAmount": 1100},
        }, 0.2)

        self.assertTrue(available)
        # 额外5bps * (买入1000 + 卖出1100) / 风险现金100 = 0.0105R。
        self.assertAlmostEqual(stressed, 0.1895)

    def test_10bps_stress_is_marked_unavailable_without_real_cash_basis(self):
        stressed, available = _stress_net_r({}, 0.2)

        self.assertFalse(available)
        self.assertEqual(stressed, 0.2)

    def test_review_normalizer_uses_review_price_risk_basis(self):
        value = {
            "decisionId": "formula:test:immediate",
            "maturity": "MATURED",
            "fillStatus": "FILLED",
            "tradeDate": "2026-09-01",
            "metrics": {
                "netPnl": 20,
                "netR": 99,
                "initialRiskCash": 999,
                "riskBasis": "PLANNED_PRICE_CONTRACT",
            },
            "entry": {"quantity": 100},
            "reviewScoreInput": {
                "priceContract": {"priceRiskMilliCny": 500},
            },
        }

        normalized = normalize_review_history_outcomes({
            "outcomes": [value],
        })[0]

        self.assertEqual(normalized["metrics"]["initialRiskCash"], 50)
        self.assertEqual(normalized["metrics"]["netR"], 0.4)
        self.assertEqual(
            normalized["metrics"]["riskBasis"],
            "REVIEW_PRICE_CONTRACT_V2",
        )
        # 输入对象不可被离线训练归一化就地修改。
        self.assertEqual(value["metrics"]["netR"], 99)

    def test_review_release_does_not_fill_top5_with_negative_expectation(self):
        dataset = {
            "y_win": np.asarray([0, 1, 1, 0, 0]),
            "y_net_r": np.asarray([-1.0, 1.0, 1.0, -5.0, -5.0]),
            "dates": np.asarray([
                "2026-08-01",
                "2026-08-02",
                "2026-09-01",
                "2026-09-01",
                "2026-09-02",
            ]),
            "codes": np.asarray([
                "600001",
                "600002",
                "600003",
                "600004",
                "600005",
            ]),
        }
        predictions = [{
            "pWinGivenFill": np.asarray([0.7, 0.2, 0.2]),
            "expectedNetR": np.asarray([0.2, -0.1, -0.2]),
            "netRLowerBound": np.asarray([0.1, -0.3, -0.4]),
        }]

        metrics, _ = _evaluate(
            dataset,
            np.asarray([0, 1]),
            np.asarray([2, 3, 4]),
            predictions,
        )

        self.assertEqual(metrics["valueTop5MeanNetR"], 0.5)

    def test_review_candidate_selects_strongest_when_multiple_models_pass(self):
        def family(lower_bound, mean_net_r):
            return {
                "aggregate": {
                    "pWinBrierSkill": 0.01,
                    "netRMaeSkill": 0.02,
                    "valueTop5LowerBound": lower_bound,
                    "valueTop5MeanNetR": mean_net_r,
                    "q10Coverage": 0.9,
                },
            }

        self.assertEqual(
            select_review_candidate({
                "lightgbm": family(0.07, 0.16),
                "catboost": family(0.15, 0.25),
            }),
            "catboost",
        )

    def test_review_candidate_rejects_when_no_model_passes(self):
        self.assertIsNone(select_review_candidate({
            "lightgbm": {
                "aggregate": {
                    "pWinBrierSkill": 0.01,
                    "netRMaeSkill": 0.02,
                    "valueTop5LowerBound": -0.01,
                    "valueTop5MeanNetR": 0.2,
                    "q10Coverage": 0.9,
                },
            },
        }))

    def test_review_contract_preserves_order(self):
        self.assertEqual(
            feature_vector(review_input()),
            [float(index) for index in range(len(FEATURE_NAMES))],
        )

    def test_dataset_separates_fill_events_from_conditional_returns(self):
        valid = {
            "maturity": "MATURED",
            "fillStatus": "FILLED",
            "tradeDate": "2026-09-01",
            "code": "600001",
            "decisionId": "decision-1:pullback",
            "parentDecisionId": "decision-1",
            "metrics": {"netR": 1.2},
            "reviewScoreInput": review_input(),
            "entry": {"at": 1_788_320_120_000},
            "exit": {"at": 1_788_406_400_000},
            "labelSource": "HISTORICAL_SIMULATION",
            "exitContractVersion": "trailing-exit.v1",
        }
        unfilled = {
            **valid,
            "code": "600002",
            "fillStatus": "TRIGGERED_UNFILLED",
            "metrics": None,
            "entry": {"at": 1_788_320_120_000},
            "exit": None,
            "reviewScoreInput": {
                **review_input(),
                "code": "600002",
            },
        }
        dataset = build_opportunity_review_dataset([
            valid,
            unfilled,
            {
                **unfilled,
                "code": "600004",
                "maturity": "PENDING",
                "fillStatus": "TRIGGERED_PENDING",
            },
            {
                **unfilled,
                "code": "600005",
                "fillStatus": "CANCELLED",
                "outcome": "USER_CANCELLED",
            },
            {
                **valid,
                "code": "600003",
                "reviewScoreInput": None,
            },
        ])

        self.assertEqual(dataset["summary"]["samples"], 1)
        self.assertEqual(dataset["summary"]["events"], 2)
        self.assertEqual(dataset["summary"]["excluded"], 3)
        self.assertEqual(dataset["summary"]["input_outcomes"], 5)
        self.assertEqual(
            dataset["summary"]["status_counts"],
            {
                "CANCELLED": 1,
                "FILLED": 2,
                "TRIGGERED_PENDING": 1,
                "TRIGGERED_UNFILLED": 1,
            },
        )
        self.assertEqual(
            dataset["summary"]["audit_counts"]["by_source"],
            {"HISTORICAL_SIMULATION": 5},
        )
        self.assertEqual(
            dataset["summary"]["audit_counts"]["by_date"],
            {"2026-09-01": 5},
        )
        self.assertEqual(
            dataset["summary"]["audit_counts"]["by_strategy"],
            {"UNKNOWN:UNKNOWN": 5},
        )
        self.assertEqual(len(dataset["event_ledger"]), 5)
        self.assertEqual(
            dataset["X_all"].shape,
            (2, len(FEATURE_NAMES)),
        )
        self.assertEqual(dataset["y_fill"].tolist(), [1, 0])
        self.assertEqual(dataset["conditional_indices"].tolist(), [0])
        self.assertEqual(
            dataset["X_opportunity"].shape,
            (2, len(FEATURE_NAMES)),
        )
        self.assertTrue(np.allclose(
            dataset["y_opportunity_r"],
            [1.2, 0.0],
        ))
        self.assertEqual(
            dataset["event_group_ids_all"].tolist(),
            ["600001:decision-1", "600002:decision-1"],
        )
        self.assertEqual(dataset["X"].shape, (1, len(FEATURE_NAMES)))
        self.assertEqual(
            dataset["event_group_ids"].tolist(),
            ["600001:decision-1"],
        )
        self.assertEqual(dataset["y_win"].tolist(), [1])
        self.assertAlmostEqual(float(dataset["y_net_r"][0]), 1.2)
        self.assertEqual(
            dataset["label_sources"].tolist(),
            ["HISTORICAL_SIMULATION"],
        )
        self.assertEqual(
            dataset["exit_contract_versions"].tolist(),
            ["trailing-exit.v1"],
        )

    def test_unfilled_event_never_receives_a_zero_return_label(self):
        invalid = {
            "maturity": "MATURED",
            "fillStatus": "TRIGGERED_UNFILLED",
            "tradeDate": "2026-09-01",
            "code": "600002",
            "metrics": {"netR": 0},
            "reviewScoreInput": {
                **review_input(),
                "code": "600002",
            },
            "entry": {"at": 1_788_320_120_000},
            "evaluatedAt": 1_788_320_180_000,
            "labelSource": "HISTORICAL_SIMULATION",
            "exitContractVersion": "trailing-exit.v1",
        }
        dataset = build_opportunity_review_dataset([invalid])

        self.assertEqual(dataset["y_fill"].tolist(), [0])
        self.assertEqual(dataset["conditional_indices"].tolist(), [])
        self.assertEqual(dataset["y_net_r"].tolist(), [])

    def test_training_dataset_excludes_non_main_board_codes(self):
        def outcome(code):
            return {
                "maturity": "MATURED",
                "fillStatus": "FILLED",
                "tradeDate": "2026-09-01",
                "code": code,
                "decisionId": f"decision-{code}:pullback",
                "parentDecisionId": f"decision-{code}",
                "metrics": {"netR": 0.5},
                "reviewScoreInput": {
                    **review_input(),
                    "code": code,
                },
                "entry": {"at": 1_788_320_120_000},
                "exit": {"at": 1_788_406_400_000},
                "labelSource": "HISTORICAL_SIMULATION",
                "exitContractVersion": "trailing-exit.v1",
            }

        dataset = build_opportunity_review_dataset([
            outcome("000001"),
            outcome("605001"),
            outcome("300001"),
            outcome("688001"),
            outcome("830001"),
        ])

        self.assertEqual(
            dataset["codes"].tolist(),
            ["000001", "605001"],
        )
        self.assertEqual(
            dataset["codes_all"].tolist(),
            ["000001", "605001"],
        )
        self.assertEqual(
            dataset["codes_opportunity"].tolist(),
            ["000001", "605001"],
        )
        self.assertEqual(
            dataset["summary"]["non_main_board_excluded"],
            3,
        )
        self.assertEqual(
            dataset["summary"]["universe"]["schema_version"],
            "cn-main-board.v1",
        )

    def test_pending_event_never_enters_a_supervised_target(self):
        pending = {
            "decisionId": "decision-pending:immediate",
            "parentDecisionId": "decision-pending",
            "maturity": "PENDING",
            "fillStatus": "TRIGGERED_PENDING",
            "tradeDate": "2026-09-01",
            "code": "600002",
            "reviewScoreInput": {
                **review_input(),
                "code": "600002",
            },
            "entry": None,
            "exit": None,
        }

        dataset = build_opportunity_review_dataset([pending])

        self.assertEqual(len(dataset["event_ledger"]), 1)
        self.assertEqual(dataset["X_all"].shape[0], 0)
        self.assertEqual(dataset["y_fill"].tolist(), [])
        self.assertEqual(dataset["X"].shape[0], 0)
        self.assertEqual(dataset["y_net_r"].tolist(), [])


if __name__ == "__main__":
    unittest.main()
