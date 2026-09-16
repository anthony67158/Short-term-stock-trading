import numpy as np

from platform_app.modules.experiments.position_target_runner import choose_values, state_features


def test_value_choice_is_paired_with_hold_and_ties_prefer_hold():
    states = np.array(["a", "a", "a", "b", "b", "b"])
    ratios = np.array([0, 1, 2, 0, 1, 2])
    predicted = np.array([.2, .2, .2, 1, 2, 3])
    actual = np.array([.1, 0, -.1, -.1, 0, .1])
    chosen = choose_values(predicted, actual, states, ratios)
    assert [r[0] for r in chosen] == [1, 5]
    np.testing.assert_allclose([r[1] for r in chosen], [0, .1])
    shifted = predicted + np.array([10, 10, 10, -5, -5, -5])
    assert choose_values(shifted, actual, states, ratios) == chosen


def test_state_features_only_use_observed_state_and_requested_target():
    base = np.zeros(31)
    base[11] = np.log1p(100000)
    features = state_features(base, 200, "10", 300)
    assert len(features) == 35
    assert features[-1] == 1.5
    assert np.isclose(features[-2], .02)
