from decimal import Decimal
import hashlib
import json

import joblib
import numpy as np
import pytest

from platform_app.modules.experiments.account_backtest import (
    _load_action_value_experiment,
    _out_of_fold_candidates,
    account_capacity_gate,
    replay_account,
)
from platform_app.modules.experiments.action_value_experiment import SCHEMA_VERSION
from platform_app.modules.experiments.action_value_validation import ActionValueFold
from platform_app.modules.experiments.action_value_walk_forward import (
    ActionValueFoldArtifact,
)
from platform_app.modules.experiments.quant_model_trainer import QuantModelError


class _PositiveBundle:
    @staticmethod
    def predict_matrix(*, base_values, scenario_values):
        count = len(base_values)
        assert len(scenario_values) == count
        return {
            "pFill": np.full(count, 0.8),
            "pFullFill": np.full(count, 0.7),
            "pWinGivenFill": np.full(count, 0.6),
            "q10": np.full(count, -0.02),
            "q50": np.full(count, 0.01),
            "q90": np.full(count, 0.04),
            "expectedNetReturnGivenFill": np.full(count, 0.02),
            "stopHazard": np.full(count, 0.2),
        }


class _PositiveActionValuePredictor:
    @staticmethod
    def predict_action_value(*, decision_date, scenario_values, board):
        assert decision_date == "20250101"
        assert len(scenario_values) == 4
        assert board == "MAIN"
        return {
            "pAnyFill": 0.8,
            "expectedFillFraction": 0.7,
            "expectedNetReturnOnRequestedNotional": 0.02,
            "hurdleExpectedNetReturnOnRequestedNotional": 0.02,
            "selectionThreshold": 0.005,
            "dailySelectionLimit": 1,
            "family": "hgb",
            "fold": 1,
        }


class _OutOfDomainPredictor:
    @staticmethod
    def predict_action_value(**_kwargs):
        return {
            "status": "OOD",
            "reasonCodes": ["UNSUPPORTED_BOARD:0"],
        }


class _UtilityOrderedPredictor:
    @staticmethod
    def predict_action_value(*, scenario_values, **_kwargs):
        return {
            "pAnyFill": 0.8,
            "expectedFillFraction": 0.7,
            "expectedNetReturnOnRequestedNotional": 0.1 - scenario_values[0],
            "hurdleExpectedNetReturnOnRequestedNotional": scenario_values[0],
            "selectionThreshold": 0.0,
            "dailySelectionLimit": 1,
            "family": "hgb",
            "fold": 1,
        }


def _candidate():
    return {
        "instrumentId": "SH.600001",
        "board": "MAIN",
        "rankPosition": 1,
        "medianAmount20Cny": "100000000",
        "baseFeatures": [0.1],
        "path": {
            "instrumentId": "SH.600001",
            "board": "MAIN",
            "decisionDate": "20250101",
            "entryDate": "20250102",
            "entryPrice": "10",
            "fillCapacityShares": 100,
            "exitPrice": "11",
            "exitReason": "TERMINAL",
            "exitDate": "20250103",
        },
    }


def test_account_replay_reserves_target_but_books_only_actual_partial_fill():
    result = replay_account(
        candidates_by_date={
            "20250101": [_candidate()],
            "20250102": [],
            "20250103": [],
        },
        close_prices={("20250102", "SH.600001"): Decimal("10.5")},
        bundle=_PositiveBundle(),
        initial_cash=Decimal("100000"),
        max_positions=1,
    )

    assert result["counts"]["ordersPlanned"] == 1
    assert result["counts"]["ordersExecuted"] == 1
    assert result["maxConcurrentPositions"] == 1
    assert result["trades"][0]["filledShares"] == 100
    assert Decimal(result["finalCashCny"]) > Decimal(result["initialCashCny"])
    assert Decimal(result["stressFinalCashCny"]) < Decimal(result["finalCashCny"])
    assert result["stressNetReturn"] > 0


def test_account_replay_accepts_calibrated_action_value_predictor():
    result = replay_account(
        candidates_by_date={
            "20250101": [_candidate()],
            "20250102": [],
            "20250103": [],
        },
        close_prices={("20250102", "SH.600001"): Decimal("10.5")},
        bundle=_PositiveActionValuePredictor(),
        initial_cash=Decimal("100000"),
        max_positions=1,
    )

    assert result["counts"]["ordersPlanned"] == 1
    assert result["trades"][0]["predictionFamily"] == "hgb"
    assert result["stressNetReturn"] > 0


def test_account_replay_prioritizes_model_utility_and_honors_daily_limit():
    lower_utility = {
        **_candidate(),
        "baseFeatures": [0.01],
    }
    higher_utility = {
        **_candidate(),
        "instrumentId": "SH.600002",
        "rankPosition": 2,
        "baseFeatures": [0.03],
        "path": {
            **_candidate()["path"],
            "instrumentId": "SH.600002",
        },
    }

    result = replay_account(
        candidates_by_date={
            "20250101": [lower_utility, higher_utility],
            "20250102": [],
            "20250103": [],
        },
        close_prices={},
        bundle=_UtilityOrderedPredictor(),
        initial_cash=Decimal("100000"),
        max_positions=2,
    )

    assert result["counts"]["ordersPlanned"] == 1
    assert result["trades"][0]["instrumentId"] == "SH.600002"
    assert result["trades"][0]["rankPosition"] == 2


def test_capacity_gate_limits_scope_instead_of_rejecting_small_accounts():
    scenarios = [
        {"initialCashCny": "100000.00", "stressNetReturn": 0.03},
        {"initialCashCny": "500000.00", "stressNetReturn": 0.02},
        {"initialCashCny": "1000000.00", "stressNetReturn": 0.01},
        {"initialCashCny": "5000000.00", "stressNetReturn": -0.01},
    ]

    gate = account_capacity_gate(scenarios)

    assert gate["passed"] is True
    assert gate["maximumSupportedCashCny"] == "1000000.00"
    assert gate["capacityRestricted"] is True
    assert gate["failedRequiredAccountsCny"] == []


def test_account_replay_counts_out_of_domain_separately():
    result = replay_account(
        candidates_by_date={"20250101": [_candidate()]},
        close_prices={},
        bundle=_OutOfDomainPredictor(),
        initial_cash=Decimal("100000"),
        max_positions=1,
    )

    assert result["counts"]["modelOutOfDomain"] == 1
    assert result["counts"].get("modelGateRejected", 0) == 0
    assert result["trades"] == []


def test_action_value_account_loader_requires_passed_five_fold_artifacts(tmp_path):
    evaluation = tmp_path / "evaluation.json"
    evaluation.write_text("{}\n")
    artifacts = []
    for fold in range(1, 6):
        path = tmp_path / f"fold-{fold}.joblib"
        joblib.dump(
            ActionValueFoldArtifact(
                fold=ActionValueFold(
                    fold=fold,
                    train_end=20240101,
                    calibration_start=20240107,
                    calibration_end=20240201,
                    test_start=20240207,
                    test_end=20240301,
                ),
                candidate=None,
                calibration=None,
            ),
            path,
        )
        artifacts.append(
            {
                "fold": fold,
                "path": path.name,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "releaseStatus": "UNAVAILABLE",
        "productionEligible": False,
        "evaluation": evaluation.name,
        "evaluationSha256": hashlib.sha256(evaluation.read_bytes()).hexdigest(),
        "foldArtifacts": artifacts,
        "gate": {"passed": True},
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))

    loaded, predictor = _load_action_value_experiment(tmp_path)

    assert loaded["gate"]["passed"] is True
    assert [item.fold.fold for item in predictor.artifacts] == [1, 2, 3, 4, 5]
    selected, excluded = _out_of_fold_candidates(
        {
            "20240101": [{}],
            "20240207": [{}],
            "20240301": [{}],
        },
        predictor,
        minimum_dates=2,
    )
    assert list(selected) == ["20240207", "20240301"]
    assert excluded == 1
    with pytest.raises(
        QuantModelError,
        match="ACTION_VALUE_ACCOUNT_OOF_COVERAGE_INSUFFICIENT",
    ):
        _out_of_fold_candidates(
            {"20240101": [{}], "20240207": [{}]},
            predictor,
            minimum_dates=2,
        )

    manifest["gate"]["passed"] = False
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(
        QuantModelError,
        match="ACTION_VALUE_ACCOUNT_EXPERIMENT_INVALID",
    ):
        _load_action_value_experiment(tmp_path)
