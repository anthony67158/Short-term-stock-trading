import numpy as np
import pytest

from platform_app.modules.experiments.action_value_models import (
    ACTION_VALUE_FAMILIES,
    ActionValueModelError,
    fit_action_value_candidate,
)
from platform_app.modules.experiments.action_value_training import (
    build_action_value_training_data,
)


def _training_data():
    rng = np.random.default_rng(97240)
    sample_count = 240
    features = rng.normal(size=(sample_count, 8)).astype(np.float32)
    dates = np.repeat(np.arange(20260101, 20260161), 4)
    boards = np.tile(np.arange(4), sample_count // 4)
    rows = []
    for index, values in enumerate(features):
        filled = values[0] + rng.normal(scale=0.3) > -0.2
        fill_fraction = 1.0 if values[1] > 0 else 0.5
        conditional_return = 0.025 * values[2] - 0.01 * values[3]
        target_notional = 1000 / fill_fraction
        rows.append(
            {
                "decision_date": int(dates[index]),
                "episode_id": f"episode-{index // 2}",
                "fill_ratio": str(fill_fraction if filled else 0),
                "p_fill_label": int(filled),
                "p_full_fill_label": int(filled and fill_fraction == 1),
                "p_win_given_fill_label": (
                    int(conditional_return > 0) if filled else None
                ),
                "net_return_given_fill": (
                    str(conditional_return) if filled else None
                ),
                "stop_hazard_label": int(values[4] > 0) if filled else None,
                "entry_price": "10" if filled else None,
                "exit_price": (
                    str(10 * (1 + conditional_return)) if filled else None
                ),
                "filled_shares": 100 if filled else 0,
                "buy_fees_cny": "0" if filled else None,
                "sell_fees_cny": "0" if filled else None,
                "target_notional_cny": str(target_notional),
            }
        )
    return build_action_value_training_data(
        features=features,
        feature_names=(
            "f0",
            "f1",
            "f2",
            "f3",
            "f4",
            "logTargetNotionalCny",
            "logTargetShares",
            "logTargetToMedianAmount",
        ),
        dates=dates,
        boards=boards,
        rows=rows,
    )


@pytest.mark.parametrize("family", ACTION_VALUE_FAMILIES)
def test_all_tree_families_fit_the_same_hurdle_contract(family):
    data = _training_data()
    train = data.dates <= 20260145

    candidate = fit_action_value_candidate(
        data,
        train,
        family=family,
        iterations=5,
        min_samples_leaf=4,
        threads=1,
    )
    predictions = candidate.predict(data.features[~train])

    assert candidate.family == family
    assert candidate.feature_names == data.feature_names
    assert candidate.base_feature_count == 5
    assert candidate.models["pAnyFill"].n_features_in_ == 5
    assert candidate.models["stopHazardGivenFill"].n_features_in_ == 5
    assert set(candidate.models) == {
        "pAnyFill",
        "fillFractionGivenFill",
        "pFullFillGivenFill",
        "pWinGivenFill",
        "stopHazardGivenFill",
        "expectedNetReturnGivenFill",
        "expectedNetReturnOnRequestedNotional",
        "q10",
        "q50",
        "q90",
    }
    assert set(predictions) == {
        "pAnyFill",
        "fillFractionGivenFill",
        "expectedFillFraction",
        "pFullFillGivenFill",
        "pFullFill",
        "pWinGivenFill",
        "stopHazardGivenFill",
        "expectedNetReturnGivenFill",
        "expectedNetReturnOnRequestedNotional",
        "hurdleExpectedNetReturnOnRequestedNotional",
        "q10GivenFill",
        "q50GivenFill",
        "q90GivenFill",
    }
    assert all(len(values) == (~train).sum() for values in predictions.values())
    assert all(np.all(np.isfinite(values)) for values in predictions.values())
    for name in (
        "pAnyFill",
        "fillFractionGivenFill",
        "expectedFillFraction",
        "pFullFillGivenFill",
        "pFullFill",
        "pWinGivenFill",
        "stopHazardGivenFill",
    ):
        assert np.all((predictions[name] >= 0) & (predictions[name] <= 1))
    assert np.all(predictions["pFullFill"] <= predictions["pAnyFill"])
    assert np.all(predictions["q10GivenFill"] <= predictions["q50GivenFill"])
    assert np.all(predictions["q50GivenFill"] <= predictions["q90GivenFill"])


def test_candidate_rejects_feature_contract_mismatch():
    data = _training_data()
    candidate = fit_action_value_candidate(
        data,
        data.dates <= 20260145,
        family="hgb",
        iterations=2,
        min_samples_leaf=4,
        threads=1,
    )

    with pytest.raises(
        ActionValueModelError,
        match="ACTION_VALUE_FEATURE_CONTRACT_MISMATCH",
    ):
        candidate.predict(np.ones((2, len(data.feature_names) - 1)))
