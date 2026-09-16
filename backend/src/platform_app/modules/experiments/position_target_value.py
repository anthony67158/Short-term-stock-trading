"""Offline target-position values with explicit execution-only future inputs."""

from decimal import Decimal, ROUND_FLOOR

from platform_app.modules.experiments.position_action_labeler import (
    POSITION_ACTION_POLICY, _buy_cost, _decimal, _sell_net, _text, action_window_capacity,
)

TARGET_RATIOS = ("0", "0.25", "0.5", "0.75", "1", "1.25", "1.5", "2")
POLICY = {
    **POSITION_ACTION_POLICY,
    "policyVersion": "position-target-value.research.v1",
    "targetRatios": list(TARGET_RATIOS),
    "currentQuantitySource": "ACTUAL_FILLED_SHARES_IN_EXECUTION_SCENARIO",
    "features": "DECISION_MARKET_FEATURES_AND_OBSERVED_POSITION_AND_REQUESTED_TARGET",
    "futureCapacity": "LABEL_ONLY_NEVER_FEATURE",
    "releaseStatus": "UNAVAILABLE",
    "blockers": [
        "HISTORICAL_BOARD_QUANTITY_RULES_UNVERIFIED",
        "LIMIT_LOCK_AND_TERMINAL_LIQUIDITY_REPLAY_PENDING",
        "ACCOUNT_BUDGET_REPLAY_PENDING",
        "JOINT_AGENT_ABLATION_PENDING",
    ],
}


def target_value_labels(*, board, current_shares, snapshot_price, action_date,
                        action_open, action_bars, terminal_date, terminal_close):
    """Research grid; shared historical simulator assumptions are not live order rules."""
    lot = POSITION_ACTION_POLICY["buyLotShares"]
    if current_shares < lot or current_shares % lot:
        raise ValueError("POSITION_TARGET_CURRENT_SHARES_INVALID")
    snapshot, action, terminal = map(_decimal, (snapshot_price, action_open, terminal_close))
    if min(snapshot, action, terminal) <= 0 or terminal_date <= action_date:
        raise ValueError("POSITION_TARGET_PATH_INVALID")
    slippage = _decimal(POSITION_ACTION_POLICY["marketSlippageBps"]) / Decimal(10000)
    buy, sell, terminal_sell = action * (1 + slippage), action * (1 - slippage), terminal * (
        1 - slippage
    )
    capacity = action_window_capacity(action_bars)
    hold = _sell_net(current_shares, terminal_sell, board, terminal_date)
    values = []
    seen = set()
    for ratio in TARGET_RATIOS:
        target = int((Decimal(current_shares) * Decimal(ratio) / lot).to_integral_value(
            rounding=ROUND_FLOOR,
        )) * lot
        if target in seen:
            continue
        seen.add(target)
        delta = target - current_shares
        filled = min(abs(delta), capacity)
        if delta > 0:
            value = -_buy_cost(filled, buy, board, action_date)
            value += _sell_net(current_shares + filled, terminal_sell, board, terminal_date)
        else:
            value = _sell_net(filled, sell, board, action_date)
            value += _sell_net(current_shares - filled, terminal_sell, board, terminal_date)
        values.append({
            "targetShares": target, "targetRatio": _text(Decimal(target) / current_shares),
            "filledActionShares": filled,
            "deltaReturnVsHold": _text((value - hold) / (snapshot * current_shares)),
        })
    return values
