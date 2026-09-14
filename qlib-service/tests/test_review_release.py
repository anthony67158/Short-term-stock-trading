import json
import os
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from decision_engine.training.review_release import (
    fresh_confirmation_partitions,
    review_promotion_gate,
    select_review_release,
)
from decision_engine.heads.review_contract import (
    FEATURE_SCHEMA_VERSION,
)
from decision_engine.heads.review_contract_v4 import (
    FEATURE_SCHEMA_VERSION_V4,
)


def evaluation(
    *,
    mean_net_r=0.05,
    lower_bound=0.01,
    precision=0.50,
    drawdown=0.50,
    selected=20,
    active_days=10,
    p_win_brier=0.20,
    p_fill_brier=0.10,
    net_r_mae=0.50,
    q10_coverage=0.90,
    stress_coverage=1.0,
    stress_lower_bound=0.005,
    account_drawdown_pct=2.0,
):
    return {
        "conditional": {
            "pWinBrier": p_win_brier,
            "netRMae": net_r_mae,
            "q10Coverage": q10_coverage,
        },
        "fill": {"pFillBrier": p_fill_brier},
        "opportunity": {
            "selected": selected,
            "activeDays": active_days,
            "precisionAt5": precision,
            "meanNetRAt5": mean_net_r,
            "netRLowerBound95": lower_bound,
            "maximumDrawdownRAt5": drawdown,
            "stress10Coverage": stress_coverage,
            "stress10NetRLowerBound95": stress_lower_bound,
            "accountDrawdownPctAtRisk07Top5": account_drawdown_pct,
        },
    }


def fresh_evidence(**overrides):
    return {
        "championCutoffDate": "20260902",
        "startDate": "20260903",
        "endDate": "20260918",
        "dates": 12,
        "conditionalSamples": 300,
        "fillSamples": 600,
        "opportunitySamples": 700,
        **overrides,
    }


class ReviewReleaseTest(unittest.TestCase):
    def test_gate_requires_business_improvement_without_regression(self):
        champion = evaluation()
        challenger = evaluation(
            mean_net_r=0.07,
            lower_bound=0.018,
            precision=0.51,
            drawdown=0.48,
        )

        result = review_promotion_gate(
            champion,
            challenger,
            fresh_evidence(),
        )

        self.assertTrue(result["passed"])
        self.assertTrue(result["improvements"])
        self.assertEqual(result["blockers"], [])

    def test_gate_rejects_negative_lower_bound_and_coverage_collapse(self):
        champion = evaluation(selected=30, active_days=15)
        challenger = evaluation(
            mean_net_r=0.08,
            lower_bound=-0.001,
            selected=8,
            active_days=6,
        )

        result = review_promotion_gate(
            champion,
            challenger,
            fresh_evidence(),
        )

        self.assertFalse(result["passed"])
        self.assertTrue(any(
            "95%下界必须大于0" in value
            for value in result["blockers"]
        ))
        self.assertTrue(any(
            "覆盖低于现役模型的一半" in value
            for value in result["blockers"]
        ))

    def test_gate_rejects_insufficient_post_champion_evidence(self):
        result = review_promotion_gate(
            evaluation(),
            evaluation(mean_net_r=0.08),
            fresh_evidence(
                dates=3,
                conditionalSamples=30,
                fillSamples=100,
                opportunitySamples=120,
            ),
        )

        self.assertFalse(result["passed"])
        self.assertTrue(any(
            "新增交易日少于10" in value
            for value in result["blockers"]
        ))

    def test_fresh_holdout_only_uses_dates_after_champion_cutoff(self):
        dataset = {
            "dates": np.asarray([
                "2026-09-01",
                "2026-09-03",
                "2026-09-04",
            ]),
            "dates_all": np.asarray([
                "2026-09-02",
                "2026-09-03",
                "2026-09-04",
            ]),
            "dates_opportunity": np.asarray([
                "2026-09-01",
                "2026-09-03",
                "2026-09-04",
            ]),
        }
        partitions = {
            "development": np.asarray([0]),
            "confirmation": np.asarray([0, 1, 2]),
            "fillDevelopment": np.asarray([0]),
            "fillConfirmation": np.asarray([0, 1, 2]),
            "opportunityConfirmation": np.asarray([0, 1, 2]),
        }
        with patch(
            "decision_engine.training.review_release."
            "_confirmation_partitions",
            return_value=partitions,
        ):
            result = fresh_confirmation_partitions(
                dataset,
                {
                    "validation": {
                        "confirmationEndDate": "2026-09-02",
                    },
                },
            )

        self.assertEqual(result["confirmation"].tolist(), [1, 2])
        self.assertEqual(result["fillConfirmation"].tolist(), [1, 2])
        self.assertEqual(
            result["opportunityConfirmation"].tolist(),
            [1, 2],
        )
        self.assertEqual(result["evidence"]["dates"], 2)
        self.assertEqual(result["evidence"]["startDate"], "2026-09-03")

    def test_selection_keeps_champion_when_fresh_evidence_is_insufficient(self):
        champion_metadata = {
            "modelVersion": "review.champion",
            "featureSchemaVersion": "review.v3",
            "featureNames": ["a"],
            "validation": {"confirmationEndDate": "2026-09-02"},
        }
        challenger_metadata = {
            **champion_metadata,
            "modelVersion": "review.challenger",
            "productionEligible": True,
        }
        evidence = fresh_evidence(
            dates=2,
            conditionalSamples=20,
            fillSamples=40,
            opportunitySamples=50,
        )
        partitions = {
            "evidence": evidence,
        }
        with tempfile.TemporaryDirectory() as directory:
            decision_path = os.path.join(directory, "decision.json")
            with patch(
                "decision_engine.training.review_release.load_dataset",
                return_value={},
            ), patch(
                "decision_engine.training.review_release._load_bundle",
                side_effect=[
                    ([], champion_metadata),
                    ([], challenger_metadata),
                ],
            ), patch(
                "decision_engine.training.review_release."
                "fresh_confirmation_partitions",
                return_value=partitions,
            ), patch(
                "decision_engine.training.review_release."
                "evaluate_review_release",
            ) as evaluate:
                decision = select_review_release(
                    "dataset.json",
                    "champion",
                    "challenger",
                    decision_output=decision_path,
                )

            self.assertEqual(decision["action"], "KEEP_CURRENT")
            self.assertEqual(
                decision["selectedVersion"],
                "review.champion",
            )
            evaluate.assert_not_called()
            with open(decision_path, encoding="utf-8") as handle:
                saved = json.load(handle)
            self.assertEqual(saved["action"], "KEEP_CURRENT")

    def test_selection_publishes_only_a_better_main_board_challenger(self):
        champion_metadata = {
            "modelVersion": "review.champion",
            "featureSchemaVersion": "review.v3",
            "featureNames": ["a"],
            "validation": {"confirmationEndDate": "2026-09-02"},
        }
        challenger_metadata = {
            **champion_metadata,
            "modelVersion": "review.challenger",
            "productionEligible": True,
        }
        dataset = {
            "summary": {
                "universe": {
                    "schema_version": "cn-main-board.v1",
                },
            },
            "codes": np.asarray(["600001"]),
            "codes_all": np.asarray(["000001"]),
            "codes_opportunity": np.asarray(["605001"]),
        }
        partitions = {"evidence": fresh_evidence()}
        with tempfile.TemporaryDirectory() as directory:
            decision_path = os.path.join(directory, "decision.json")
            with patch(
                "decision_engine.training.review_release.load_dataset",
                return_value=dataset,
            ), patch(
                "decision_engine.training.review_release._load_bundle",
                side_effect=[
                    (["champion"], champion_metadata),
                    (["challenger"], challenger_metadata),
                ],
            ), patch(
                "decision_engine.training.review_release."
                "fresh_confirmation_partitions",
                return_value=partitions,
            ), patch(
                "decision_engine.training.review_release."
                "evaluate_review_release",
                side_effect=[
                    evaluation(),
                    evaluation(
                        mean_net_r=0.07,
                        lower_bound=0.018,
                    ),
                ],
            ):
                decision = select_review_release(
                    "dataset.json",
                    "champion",
                    "challenger",
                    decision_output=decision_path,
                )

        self.assertEqual(decision["action"], "PUBLISH")
        self.assertTrue(decision["eligible"])
        self.assertEqual(
            decision["selectedVersion"],
            "review.challenger",
        )

    def test_v4_challenger_publishes_against_v4_champion(self):
        # v4 冠军 vs v4 挑战者：合同一致，允许同窗评估并按改善晋级。
        champion_metadata = {
            "modelVersion": "review.champion.v4",
            "featureSchemaVersion": FEATURE_SCHEMA_VERSION_V4,
            "featureNames": ["a"],
            "validation": {"confirmationEndDate": "2026-09-02"},
        }
        challenger_metadata = {
            **champion_metadata,
            "modelVersion": "review.challenger.v4",
            "productionEligible": True,
        }
        dataset = {
            "summary": {
                "universe": {"schema_version": "cn-main-board.v1"},
            },
            "codes": np.asarray(["600001"]),
            "codes_all": np.asarray(["000001"]),
            "codes_opportunity": np.asarray(["605001"]),
        }
        partitions = {"evidence": fresh_evidence()}
        with tempfile.TemporaryDirectory() as directory:
            decision_path = os.path.join(directory, "decision.json")
            with patch(
                "decision_engine.training.review_release.load_dataset",
                return_value=dataset,
            ) as load_dataset_mock, patch(
                "decision_engine.training.review_release._load_bundle",
                side_effect=[
                    (["champion"], champion_metadata),
                    (["challenger"], challenger_metadata),
                ],
            ), patch(
                "decision_engine.training.review_release."
                "fresh_confirmation_partitions",
                return_value=partitions,
            ), patch(
                "decision_engine.training.review_release."
                "evaluate_review_release",
                side_effect=[
                    evaluation(),
                    evaluation(mean_net_r=0.07, lower_bound=0.018),
                ],
            ):
                decision = select_review_release(
                    "dataset.json",
                    "champion",
                    "challenger",
                    decision_output=decision_path,
                )

        # 数据集必须按 v4 合同装配（关键：否则特征维度与 v4 模型不匹配）。
        self.assertEqual(
            load_dataset_mock.call_args.kwargs["feature_schema"],
            "v4",
        )
        self.assertEqual(decision["action"], "PUBLISH")
        self.assertTrue(decision["eligible"])
        self.assertEqual(
            decision["challengerFeatureSchemaVersion"],
            FEATURE_SCHEMA_VERSION_V4,
        )

    def test_v4_challenger_blocked_against_v3_champion(self):
        # v3 冠军 vs v4 挑战者：合同不一致，硬拦截 → KEEP_CURRENT，绝不覆盖生产 v3。
        champion_metadata = {
            "modelVersion": "review.champion.v3",
            "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
            "featureNames": ["a"],
            "validation": {"confirmationEndDate": "2026-09-02"},
        }
        challenger_metadata = {
            "modelVersion": "review.challenger.v4",
            "featureSchemaVersion": FEATURE_SCHEMA_VERSION_V4,
            "featureNames": ["a", "alpha_x"],
            "validation": {"confirmationEndDate": "2026-09-02"},
            "productionEligible": True,
        }
        dataset = {
            "summary": {
                "universe": {"schema_version": "cn-main-board.v1"},
            },
            "codes": np.asarray(["600001"]),
            "codes_all": np.asarray(["000001"]),
            "codes_opportunity": np.asarray(["605001"]),
        }
        partitions = {"evidence": fresh_evidence()}
        with tempfile.TemporaryDirectory() as directory:
            decision_path = os.path.join(directory, "decision.json")
            with patch(
                "decision_engine.training.review_release.load_dataset",
                return_value=dataset,
            ), patch(
                "decision_engine.training.review_release._load_bundle",
                side_effect=[
                    (["champion"], champion_metadata),
                    (["challenger"], challenger_metadata),
                ],
            ), patch(
                "decision_engine.training.review_release."
                "fresh_confirmation_partitions",
                return_value=partitions,
            ), patch(
                "decision_engine.training.review_release."
                "evaluate_review_release",
            ) as evaluate:
                decision = select_review_release(
                    "dataset.json",
                    "champion",
                    "challenger",
                    decision_output=decision_path,
                )

        self.assertEqual(decision["action"], "KEEP_CURRENT")
        self.assertFalse(decision["eligible"])
        self.assertIn(
            "现役模型与挑战者特征合同不一致",
            decision["compatibility"]["blockers"],
        )
        self.assertEqual(decision["selectedVersion"], "review.champion.v3")
        # 合同不一致时绝不进入同窗评估。
        evaluate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
