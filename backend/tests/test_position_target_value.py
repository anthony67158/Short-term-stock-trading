from decimal import Decimal

from platform_app.modules.experiments.position_action_labeler import label_position_actions
from platform_app.modules.experiments.position_target_value import target_value_labels


def test_target_grid_matches_discrete_actions_and_deduplicates_lots():
    payload = dict(
        board="MAIN", current_shares=400, snapshot_price="10",
        action_date="20250102", action_open="10", terminal_date="20250106",
        terminal_close="11", action_bars=[
            {"tradeDate": "20250102", "barEndShanghai": f"2025-01-02 {time}",
             "volumeShares": "100000"}
            for time in ("09:35:00", "09:40:00", "09:45:00", "09:50:00", "09:55:00", "10:00:00")
        ],
    )
    old = label_position_actions(**payload)
    new = {r["targetShares"]: r for r in target_value_labels(**payload)}
    assert len(new) == 8
    for target, action in ((0, "EXIT"), (200, "REDUCE"), (400, "HOLD"), (800, "ADD")):
        assert new[target]["deltaReturnVsHold"] == old["deltaReturnVsHold"][action]
    payload["current_shares"] = 100
    assert len(target_value_labels(**payload)) == 3


def test_no_capacity_means_all_actions_have_hold_value():
    rows = target_value_labels(
        board="BEIJING", current_shares=200, snapshot_price="10", action_date="20250102",
        action_open="10", terminal_date="20250106", terminal_close="11", action_bars=[
            {"tradeDate": "20250102", "barEndShanghai": f"2025-01-02 {time}",
             "volumeShares": "0"}
            for time in ("09:35:00", "09:40:00", "09:45:00", "09:50:00", "09:55:00", "10:00:00")
        ],
    )
    assert all(Decimal(row["deltaReturnVsHold"]) == 0 for row in rows)
