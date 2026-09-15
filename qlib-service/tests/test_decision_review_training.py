import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

import numpy as np


SERVICE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from decision_engine.heads.review_contract import FEATURE_NAMES  # noqa: E402
from decision_engine.heads.review_contract_v4 import (  # noqa: E402
    FEATURE_NAMES_V4,
    FEATURE_SCHEMA_VERSION_V4,
)
from decision_engine.heads.review_contract import (  # noqa: E402
    FEATURE_SCHEMA_VERSION,
)
from decision_engine.training.review_ensemble import (  # noqa: E402
    MINIMUM_ANNUALIZED_TRADES,
    POLICY_MINIMUM_EXPECTED_R,
    _account_metrics,
    _fit_member,
    _resolve_feature_schema,
    _select_opportunity_policy,
    train_review_ensemble,
)
from decision_engine.training.bakeoff import _probability  # noqa: E402
from decision_engine.training.review_dataset import (  # noqa: E402
    review_feature_coverage_audit,
)


class DecisionReviewTrainingTest(unittest.TestCase):
    def test_probability_accepts_json_model_raw_logits(self):
        class JsonModel:
            @staticmethod
            def predict(_matrix):
                return np.asarray([-2.0, 0.0, 2.0])

        probabilities = _probability(
            JsonModel(),
            np.zeros((3, 1)),
        )

        np.testing.assert_allclose(
            probabilities,
            [0.119202922, 0.5, 0.880797078],
        )

    def test_v4_policy_search_never_allows_negative_expected_net_r(self):
        self.assertTrue(POLICY_MINIMUM_EXPECTED_R)
        self.assertGreaterEqual(min(POLICY_MINIMUM_EXPECTED_R), 0.0)
        self.assertGreaterEqual(MINIMUM_ANNUALIZED_TRADES, 80)

    def test_policy_search_prefers_qualified_coverage_over_sparse_profit(self):
        def metrics(_dataset, _holdout, _predictions, policy):
            qualified = (
                policy["rankingMode"] == "VALUE"
                and policy["minimumExpectedNetR"] == 0.0
                and policy["minimumNetRLowerBound"] == -1.0
                and policy["minimumPFill"] == 0.0
                and not policy["allowedSectorPhases"]
            )
            sparse = policy["minimumNetRLowerBound"] == 0.0
            return {
                "selected": 40 if qualified else (5 if sparse else 0),
                "activeDays": 30 if qualified else (5 if sparse else 0),
                "netRLowerBound95": 0.1 if qualified else 0.5,
                "stress10NetRLowerBound95": 0.08 if qualified else 0.4,
                "meanNetRAt5": 0.01 if qualified else 0.6,
                "precisionAt5": 0.5,
                "account": {
                    "annualizedTrades": 100 if qualified else 20,
                },
            }

        with patch(
            "decision_engine.training.review_ensemble._policy_metrics",
            side_effect=metrics,
        ):
            selected, _leaders = _select_opportunity_policy(
                {},
                np.asarray([], dtype=np.int64),
                {"DECOMPOSED": []},
            )

        self.assertEqual(
            selected["metrics"]["account"]["annualizedTrades"],
            100,
        )
        self.assertEqual(
            selected["policy"]["minimumNetRLowerBound"],
            -1.0,
        )

    def test_policy_search_keeps_positive_edge_when_coverage_is_short(self):
        def metrics(_dataset, _holdout, _predictions, policy):
            broad = (
                policy["rankingMode"] == "VALUE"
                and policy["minimumExpectedNetR"] == 0.0
                and policy["minimumNetRLowerBound"] == -1.0
                and policy["minimumPFill"] == 0.0
                and not policy["allowedSectorPhases"]
            )
            return {
                "selected": 70 if broad else 5,
                "activeDays": 45 if broad else 5,
                "netRLowerBound95": -0.02 if broad else 0.5,
                "stress10NetRLowerBound95": -0.03 if broad else 0.4,
                "meanNetRAt5": 0.01 if broad else 0.6,
                "precisionAt5": 0.5,
                "account": {
                    "annualizedTrades": 70 if broad else 20,
                },
            }

        with patch(
            "decision_engine.training.review_ensemble._policy_metrics",
            side_effect=metrics,
        ):
            selected, _leaders = _select_opportunity_policy(
                {},
                np.asarray([], dtype=np.int64),
                {"DECOMPOSED": []},
            )

        self.assertEqual(
            selected["metrics"]["account"]["annualizedTrades"],
            20,
        )
        self.assertEqual(
            selected["policy"]["minimumNetRLowerBound"],
            0.0,
        )

    def test_account_metrics_use_actual_daily_selection_count(self):
        dates = [f"2025-{index:03d}" for index in range(300)]
        ranking = {
            "daily_net_r": {date: 0.1 for date in dates},
            "daily_selected": {date: 2 for date in dates},
        }
        stress = {
            "daily_net_r": {date: 0.05 for date in dates},
            "daily_selected": {date: 2 for date in dates},
        }

        metrics = _account_metrics(ranking, stress)

        self.assertEqual(metrics["trades"], 600)
        self.assertEqual(metrics["annualizedTrades"], 504)
        self.assertGreater(metrics["returnPct"], 0)
        self.assertEqual(metrics["rolling12MonthProfitProbability"], 1.0)
        self.assertGreater(metrics["stress10ReturnPct"], 0)
        self.assertEqual(metrics["maximumDrawdownPct"], 0)

    def test_account_trade_coverage_counts_only_filled_selections(self):
        dates = [f"2025-{index:03d}" for index in range(252)]
        ranking = {
            "daily_net_r": {date: 0.1 for date in dates},
            "daily_selected": {date: 2 for date in dates},
            "daily_executed": {
                date: 1 if index % 2 == 0 else 0
                for index, date in enumerate(dates)
            },
        }

        metrics = _account_metrics(ranking, None)

        self.assertEqual(metrics["recommendations"], 504)
        self.assertEqual(metrics["trades"], 126)
        self.assertEqual(metrics["annualizedTrades"], 126)

    def dataset(self, feature_names=FEATURE_NAMES, date_count=50):
        samples_per_date = 10
        dates = np.repeat(np.asarray([
            f"day-{day:04d}"
            for day in range(1, date_count + 1)
        ]), samples_per_date)
        starts = np.arange(1, len(dates) + 1, dtype=np.int64) * 1_000
        matrix = np.zeros(
            (len(dates), len(feature_names)),
            dtype=np.float32,
        )
        matrix[:, 0] = np.arange(len(dates), dtype=np.float32)
        if tuple(feature_names) == FEATURE_NAMES_V4:
            matrix[
                :,
                feature_names.index("initial_sectorContextAvailable"),
            ] = 1.0
        groups = np.asarray([
            f"600001:event-{index}"
            for index in range(len(dates))
        ])
        return {
            "X": matrix,
            "X_all": matrix.copy(),
            "X_opportunity": matrix.copy(),
            "dates_all": dates.copy(),
            "dates_opportunity": dates.copy(),
            "codes_all": np.asarray(["600001"] * len(dates)),
            "codes_opportunity": np.asarray(
                ["600001"] * len(dates)
            ),
            "dates": dates,
            "codes": np.asarray(["600001"] * len(dates)),
            "event_group_ids": groups,
            "event_group_ids_all": groups.copy(),
            "event_group_ids_opportunity": groups.copy(),
            "label_start_ms_all": starts.copy(),
            "label_end_ms_all": starts + 50,
            "label_start_ms_opportunity": starts.copy(),
            "label_end_ms_opportunity": starts + 100,
            "label_start_ms": starts,
            "label_end_ms": starts + 100,
            "y_fill": np.arange(len(dates)) % 2,
            "y_win": np.arange(len(dates)) % 2,
            "y_net_r": np.where(
                np.arange(len(dates)) % 2,
                1.0,
                -1.0,
            ),
            "y_opportunity_r": np.where(
                np.arange(len(dates)) % 2,
                1.0,
                0.0,
            ),
            "sector_phases_opportunity": np.asarray(
                ["ACCUMULATION"] * len(dates)
            ),
            "feature_names": np.asarray(feature_names),
        }

    def test_v4_feature_audit_blocks_missing_direct_inputs(self):
        dataset = self.dataset(FEATURE_NAMES_V4, date_count=800)
        matrix = dataset["X_opportunity"]
        matrix[:, FEATURE_NAMES_V4.index("vwapMissing")] = 1.0
        matrix[
            :,
            FEATURE_NAMES_V4.index("initialExpectedNetRMissing"),
        ] = 1.0

        audit = review_feature_coverage_audit(dataset)

        self.assertFalse(audit["trainingReady"])
        self.assertEqual(audit["coverage"]["reviewVwap"], 0.0)
        self.assertEqual(audit["coverage"]["initialExpectedNetR"], 0.0)
        self.assertTrue(any(
            "reviewVwap" in blocker
            for blocker in audit["blockers"]
        ))

    def _run_training(self, dataset, **train_kwargs):
        def member(
            _dataset,
            _train,
            _calibration,
            _fill_train,
            _fill_calibration,
            _opportunity_train,
            seed,
            _estimators,
            _threads,
        ):
            return {
                "config": {
                    "seed": seed,
                    "activeFeatures": [0],
                    "activeFillFeatures": [0],
                    "activeRankFeatures": [0],
                    "pFillCalibration": {"method": "sigmoid"},
                    "pWinCalibration": {"method": "sigmoid"},
                    "q10CalibrationOffset": 0.0,
                },
                "models": {"mock": object()},
            }

        def predictions(_member, matrix):
            return {
                "pFill": np.full(len(matrix), 0.5),
                "pWinGivenFill": np.full(len(matrix), 0.5),
                "expectedNetR": np.zeros(len(matrix)),
                "decomposedExpectedNetR": np.zeros(len(matrix)),
                "directExpectedNetR": np.full(len(matrix), 0.1),
                "netRLower10": np.full(len(matrix), -1.0),
                "netRLowerBound": np.full(len(matrix), -1.0),
                "rankingScoreRaw": np.arange(
                    len(matrix),
                    dtype=np.float64,
                ),
            }

        def evaluation(_dataset, _development, indices, predictions):
            score = float(np.mean(predictions[0]["expectedNetR"]))
            return {
                "samples": len(indices),
                "valueTop5LowerBound": score,
                "valueTop5MeanNetR": score,
                "netRMaeSkill": score,
            }, []

        with tempfile.TemporaryDirectory() as output:
            with ExitStack() as stack:
                stack.enter_context(patch(
                    "decision_engine.training.review_ensemble.load_dataset",
                    return_value=dataset,
                ))
                fit = stack.enter_context(patch(
                    "decision_engine.training.review_ensemble._fit_member",
                    side_effect=member,
                ))
                stack.enter_context(patch(
                    "decision_engine.training.review_ensemble."
                    "_member_predictions",
                    side_effect=predictions,
                ))
                evaluate = stack.enter_context(patch(
                    "decision_engine.training.review_ensemble._evaluate",
                    side_effect=evaluation,
                ))
                stack.enter_context(patch(
                    "decision_engine.training.review_ensemble."
                    "_select_opportunity_policy",
                    return_value=({
                        "policy": {
                            "schemaVersion":
                                "review-selection-policy.v1",
                            "valueHead": "DIRECT",
                            "rankingMode": "VALUE",
                            "minimumPFill": 0.0,
                            "minimumPWinGivenFill": 0.0,
                            "minimumExpectedNetR": -1.0,
                            "minimumNetRLowerBound": -2.0,
                            "allowedSectorPhases": [],
                        },
                        "metrics": {
                            "netRLowerBound95": 0.1,
                        },
                    }, []),
                ))
                stack.enter_context(patch(
                    "decision_engine.training.review_ensemble."
                    "_catboost_payload",
                    return_value={},
                ))
                stack.enter_context(patch(
                    "decision_engine.training.review_ensemble."
                    "validate_review_metadata",
                ))
                metadata = train_review_ensemble(
                    "unused.json",
                    output,
                    seeds=(42, 7),
                    **train_kwargs,
                )
        return metadata, evaluate, fit

    def test_training_reserves_selection_and_confirmation_partitions(self):
        dataset = self.dataset()
        metadata, evaluate, fit = self._run_training(dataset)

        selection = evaluate.call_args_list[0].args[2]
        confirmation = evaluate.call_args_list[2].args[2]
        self.assertFalse(set(selection.tolist()) & set(confirmation.tolist()))
        self.assertEqual(
            metadata["validation"]["selectionMetrics"][
                "candidates"
            ]["DIRECT"]["metrics"]["samples"],
            len(selection),
        )
        self.assertEqual(
            metadata["validation"]["confirmationMetrics"]["samples"],
            len(confirmation),
        )
        self.assertLess(
            metadata["validation"]["selectionEndDate"],
            metadata["validation"]["confirmationStartDate"],
        )
        self.assertEqual(metadata["valueHead"], "DIRECT")
        self.assertTrue(np.allclose(
            evaluate.call_args_list[2].args[3][0]["expectedNetR"],
            0.1,
        ))
        self.assertEqual(fit.call_count, 2)
        audit = metadata["confirmationAudit"]
        self.assertRegex(audit["selectionDataHash"], r"^[0-9a-f]{64}$")
        self.assertRegex(audit["candidateHash"], r"^[0-9a-f]{64}$")
        self.assertRegex(audit["confirmationDataHash"], r"^[0-9a-f]{64}$")

    def test_training_rejects_fill_labels_without_both_classes(self):
        dataset = self.dataset()
        dataset["y_fill"] = np.ones(len(dataset["X_all"]), dtype=np.int8)
        development = np.arange(0, 200)
        calibration = np.arange(200, 260)

        with self.assertRaisesRegex(ValueError, "成交训练集缺少正负样本"):
            _fit_member(
                dataset,
                development,
                calibration,
                development,
                calibration,
                development,
                42,
                10,
                1,
            )

    def test_default_feature_schema_is_v3(self):
        # 生产默认必须仍是 v3：168 维、v3 schema 名，不受 v4 接入影响。
        metadata, _, _ = self._run_training(self.dataset())
        self.assertEqual(
            metadata["featureSchemaVersion"],
            FEATURE_SCHEMA_VERSION,
        )
        self.assertEqual(len(metadata["featureNames"]), len(FEATURE_NAMES))
        self.assertEqual(tuple(metadata["featureNames"]), tuple(FEATURE_NAMES))

    def test_v4_feature_schema_propagates_to_artifact_and_metadata(self):
        # 显式 feature_schema="v4" 时，artifact/metadata 全部写 v4 176 维口径。
        dataset = self.dataset(FEATURE_NAMES_V4, date_count=800)
        metadata, _, _ = self._run_training(
            dataset,
            feature_schema="v4",
        )
        self.assertEqual(
            metadata["featureSchemaVersion"],
            FEATURE_SCHEMA_VERSION_V4,
        )
        self.assertEqual(len(metadata["featureNames"]), len(FEATURE_NAMES_V4))
        self.assertEqual(
            tuple(metadata["featureNames"]),
            tuple(FEATURE_NAMES_V4),
        )
        # featureSupport 的分位向量长度也必须跟随 176 维。
        self.assertEqual(
            len(metadata["featureSupport"]["lower"]),
            len(FEATURE_NAMES_V4),
        )
        self.assertEqual(
            metadata["validation"]["split"]["minimum_confirmation_dates"],
            252,
        )
        self.assertEqual(
            metadata["validation"]["confirmationMetrics"][
                "opportunityPolicy"
            ]["metrics"]["account"]["tradingDays"],
            252,
        )

    def test_resolve_feature_schema_rejects_unknown(self):
        with self.assertRaisesRegex(ValueError, "仅支持 v3 或 v4"):
            _resolve_feature_schema("v5")
        # v3/v4 分别解析出正确维度与缺失掩码列数。
        _, v3_names, v3_missing = _resolve_feature_schema("v3")
        _, v4_names, v4_missing = _resolve_feature_schema("v4")
        self.assertEqual(len(v3_names), len(FEATURE_NAMES))
        self.assertEqual(len(v4_names), len(FEATURE_NAMES_V4))
        # v4 比 v3 多 3 个 alpha Missing 掩码列（共 8 维 alpha 中的 3 个）。
        self.assertEqual(len(v4_missing) - len(v3_missing), 3)


if __name__ == "__main__":
    unittest.main()
