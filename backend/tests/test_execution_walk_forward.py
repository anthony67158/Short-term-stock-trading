import numpy as np
import pytest

from platform_app.modules.experiments.execution_walk_forward import (
    execution_splits, requested_notional_return, scenario_weights, train_fold,
)


def test_splits_purge_both_label_boundaries_and_cover_each_test_date_once():
    dates = np.repeat(np.arange(503), 4)
    splits = execution_splits(dates)
    seen = np.zeros(len(dates), dtype=int)
    for train, calibration, test in splits:
        assert dates[calibration].min() - dates[train].max() == 6
        assert dates[test].min() - dates[calibration].max() == 6
        seen += test
    assert np.all(seen[dates >= 199] == 1)
    assert np.all(seen[dates < 199] == 0)


def test_weights_are_equal_by_date_and_episode_and_unchanged_by_future():
    dates = np.array([1, 1, 1, 2])
    episodes = ["a", "a", "b", "c"]
    weights = scenario_weights(dates, episodes)
    assert weights.tolist() == [.25, .25, .5, 1]
    extended = scenario_weights(np.append(dates, [3, 3]), episodes + ["d", "d"])
    np.testing.assert_array_equal(weights, extended[:4])


def test_requested_return_uses_actual_cash_fees_and_partial_fill():
    row = dict(filled_shares=100, entry_price="10", exit_price="11",
               buy_fees_cny="5", sell_fees_cny="6", target_notional_cny="2000")
    assert requested_notional_return(row) == pytest.approx(.0445)
    assert requested_notional_return({"filled_shares": 0}) == 0


def test_future_targets_do_not_change_predictions():
    rng = np.random.default_rng(92)
    dates = np.repeat(np.arange(503), 10)
    x = rng.normal(size=(len(dates), 4))
    fill = rng.choice([0, .5, 1], size=len(dates))
    returns = rng.normal(0, .1, len(dates))
    targets = {
        "pFill": (fill > 0).astype(int), "pFullFill": (fill == 1).astype(int),
        "pWinGivenFill": (returns > 0).astype(int), "fillFraction": fill,
        "conditionalReturn": returns, "netReturnOnRequestedNotional": fill * returns,
    }
    masks = execution_splits(dates)[0]
    weights = np.ones(len(dates))
    _, before, _ = train_fold(x, targets, dates, weights, masks, iterations=2, threads=1)
    changed = {name: value.copy() for name, value in targets.items()}
    for name in ("conditionalReturn", "netReturnOnRequestedNotional"):
        changed[name][masks[2]] += 10
    changed["pWinGivenFill"][masks[2]] = 1 - changed["pWinGivenFill"][masks[2]]
    _, after, _ = train_fold(x, changed, dates, weights, masks, iterations=2, threads=1)
    for name in before:
        np.testing.assert_array_equal(before[name], after[name])
