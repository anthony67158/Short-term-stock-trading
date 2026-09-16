from platform_app.modules.experiments.position_action_labeler import (
    action_window_capacity,
    label_position_actions,
)


def _bars(volume="100000"):
    return [
        {
            "tradeDate": "20250103",
            "barEndShanghai": f"2025-01-03 {time}",
            "volumeShares": volume,
        }
        for time in (
            "09:35:00",
            "09:40:00",
            "09:45:00",
            "09:50:00",
            "09:55:00",
            "10:00:00",
        )
    ]


def _label(terminal_close):
    return label_position_actions(
        board="MAIN",
        current_shares=200,
        snapshot_price="10",
        action_date="20250103",
        action_open="10",
        action_bars=_bars(),
        terminal_date="20250108",
        terminal_close=terminal_close,
    )


def test_position_actions_are_paired_against_hold_on_the_same_path():
    flat = _label("10")
    falling = _label("8")
    rising = _label("12")

    assert flat["bestAction"] == "HOLD"
    assert flat["deltaReturnVsHold"]["HOLD"] == "0"
    assert falling["bestAction"] == "EXIT"
    assert rising["bestAction"] == "ADD"
    assert flat["actionFilledShares"] == {
        "HOLD": 0,
        "ADD": 200,
        "REDUCE": 100,
        "EXIT": 200,
    }


def test_position_action_capacity_uses_each_bar_participation_limit():
    assert action_window_capacity(_bars(volume="1999")) == 0
    assert action_window_capacity(_bars(volume="2000")) == 600
