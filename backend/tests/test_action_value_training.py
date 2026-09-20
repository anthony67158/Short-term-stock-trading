from copy import deepcopy

import numpy as np
import pytest

from platform_app.modules.experiments.action_value_training import (
    ActionValueTrainingError,
    build_action_value_training_data,
    requested_notional_return,
    scenario_weights,
    with_multifactor_features,
)
from platform_app.modules.experiments.multifactor_features import FACTOR_FAMILIES


def _rows():
    return [
        {
            "decision_date": 20260105,
            "episode_id": "a",
            "fill_ratio": "0.5",
            "p_fill_label": 1,
            "p_full_fill_label": 0,
            "p_win_given_fill_label": 1,
            "net_return_given_fill": "0.089",
            "stop_hazard_label": 0,
            "entry_price": "10",
            "exit_price": "11",
            "filled_shares": 100,
            "buy_fees_cny": "5",
            "sell_fees_cny": "6",
            "target_notional_cny": "2000",
        },
        {
            "decision_date": 20260105,
            "episode_id": "a",
            "fill_ratio": "0",
            "p_fill_label": 0,
            "p_full_fill_label": 0,
            "p_win_given_fill_label": None,
            "net_return_given_fill": None,
            "stop_hazard_label": None,
            "entry_price": None,
            "exit_price": None,
            "filled_shares": 0,
            "buy_fees_cny": None,
            "sell_fees_cny": None,
            "target_notional_cny": "10000",
        },
        {
            "decision_date": 20260105,
            "episode_id": "b",
            "fill_ratio": "1",
            "p_fill_label": 1,
            "p_full_fill_label": 1,
            "p_win_given_fill_label": 0,
            "net_return_given_fill": "-0.02",
            "stop_hazard_label": 1,
            "entry_price": "10",
            "exit_price": "9.9",
            "filled_shares": 100,
            "buy_fees_cny": "5",
            "sell_fees_cny": "5",
            "target_notional_cny": "1000",
        },
        {
            "decision_date": 20260106,
            "episode_id": "c",
            "fill_ratio": "0",
            "p_fill_label": 0,
            "p_full_fill_label": 0,
            "p_win_given_fill_label": None,
            "net_return_given_fill": None,
            "stop_hazard_label": None,
            "entry_price": None,
            "exit_price": None,
            "filled_shares": 0,
            "buy_fees_cny": None,
            "sell_fees_cny": None,
            "target_notional_cny": "10000",
        },
    ]


def _build(rows=None, features=None, dates=None):
    rows = rows or _rows()
    return build_action_value_training_data(
        features=(
            np.arange(len(rows) * 2, dtype=np.float32).reshape(len(rows), 2)
            if features is None
            else features
        ),
        feature_names=("return20", "targetParticipation"),
        dates=(
            np.asarray([row["decision_date"] for row in rows], dtype=np.int32)
            if dates is None
            else dates
        ),
        boards=np.asarray([0, 0, 1, 2], dtype=np.int8),
        rows=rows,
    )


def test_date_and_episode_weights_do_not_overweight_scenario_routes():
    dates = np.asarray([1, 1, 1, 2])
    weights = scenario_weights(dates, ["a", "a", "b", "c"])

    assert weights.tolist() == [0.25, 0.25, 0.5, 1.0]
    assert weights[dates == 1].sum() == pytest.approx(1)
    assert weights[dates == 2].sum() == pytest.approx(1)


def test_requested_return_is_fee_after_on_requested_capital_and_no_fill_is_zero():
    assert requested_notional_return(_rows()[0]) == pytest.approx(0.0445)
    assert requested_notional_return(_rows()[1]) == 0


def test_action_value_contract_builds_aligned_hurdle_targets():
    data = _build()

    assert data.feature_names == ("return20", "targetParticipation")
    assert data.p_any_fill.tolist() == [1, 0, 1, 0]
    assert data.conditional_available.tolist() == [True, False, True, False]
    assert data.stop_hazard_given_fill.tolist() == [0, 0, 1, 0]
    assert data.net_return_on_requested_notional.tolist() == pytest.approx(
        [0.0445, 0, -0.02, 0]
    )
    assert data.weights.tolist() == [0.25, 0.25, 0.5, 1.0]


@pytest.mark.parametrize(
    ("features", "dates", "error"),
    [
        (
            np.asarray([[1.0, np.nan], [2, 3], [4, 5], [6, 7]]),
            None,
            "ACTION_VALUE_FEATURE_NON_FINITE",
        ),
        (
            np.ones((3, 2)),
            None,
            "ACTION_VALUE_ROW_COUNT_MISMATCH",
        ),
        (
            None,
            np.asarray([20260105, 20260106, 20260105, 20260106]),
            "ACTION_VALUE_DATE_ALIGNMENT_INVALID",
        ),
    ],
)
def test_action_value_contract_rejects_invalid_or_misaligned_features(
    features, dates, error
):
    with pytest.raises(ActionValueTrainingError, match=error):
        _build(features=features, dates=dates)


def test_action_value_contract_rejects_inconsistent_no_fill_label():
    rows = deepcopy(_rows())
    rows[1]["net_return_given_fill"] = "0.01"

    with pytest.raises(
        ActionValueTrainingError,
        match="ACTION_VALUE_HURDLE_LABEL_INVALID",
    ):
        _build(rows=rows)


def _technical_scenario_data():
    rows = _rows()
    return build_action_value_training_data(
        features=np.arange(
            len(rows) * 5,
            dtype=np.float32,
        ).reshape(len(rows), 5),
        feature_names=(
            "technicalA",
            "technicalB",
            "logTargetNotionalCny",
            "logTargetShares",
            "logTargetToMedianAmount",
        ),
        dates=np.asarray(
            [row["decision_date"] for row in rows],
            dtype=np.int32,
        ),
        boards=np.asarray([0, 0, 1, 2], dtype=np.int8),
        rows=rows,
    )


def _factor_vectors():
    return {
        episode: tuple(
            float(index + offset)
            for index in range(12)
        )
        for offset, episode in enumerate(("a", "b", "c"))
    }


def test_multifactor_feature_sets_preserve_episode_and_scenario_alignment():
    data = _technical_scenario_data()
    names = tuple(
        [f"factorScore_{family}" for family in FACTOR_FAMILIES]
        + [f"factorMissing_{family}" for family in FACTOR_FAMILIES]
    )

    factor = with_multifactor_features(
        data,
        factor_vectors=_factor_vectors(),
        factor_feature_names=names,
        feature_set="factor",
    )
    fusion = with_multifactor_features(
        data,
        factor_vectors=_factor_vectors(),
        factor_feature_names=names,
        feature_set="fusion",
    )

    assert factor.features.shape == (4, 15)
    assert fusion.features.shape == (4, 17)
    assert factor.feature_names == (
        *names,
        "logTargetNotionalCny",
        "logTargetShares",
        "logTargetToMedianAmount",
    )
    assert fusion.feature_names[:2] == ("technicalA", "technicalB")
    assert np.array_equal(factor.features[0, :12], factor.features[1, :12])
    assert not np.array_equal(factor.features[0, -3:], factor.features[1, -3:])
    assert np.array_equal(fusion.features[:, :2], data.features[:, :2])


@pytest.mark.parametrize(
    ("vectors", "feature_set", "error"),
    [
        (
            {"a": (1,) * 12, "b": (1,) * 12},
            "factor",
            "ACTION_VALUE_FACTOR_COVERAGE_INCOMPLETE",
        ),
        (
            {
                "a": (1,) * 11,
                "b": (1,) * 11,
                "c": (1,) * 11,
            },
            "fusion",
            "ACTION_VALUE_FACTOR_FEATURE_CONTRACT_INVALID",
        ),
        (
            _factor_vectors(),
            "unknown",
            "ACTION_VALUE_FEATURE_SET_INVALID",
        ),
    ],
)
def test_multifactor_feature_sets_reject_invalid_contracts(
    vectors,
    feature_set,
    error,
):
    with pytest.raises(ActionValueTrainingError, match=error):
        with_multifactor_features(
            _technical_scenario_data(),
            factor_vectors=vectors,
            factor_feature_names=tuple(f"factor-{index}" for index in range(12)),
            feature_set=feature_set,
        )
