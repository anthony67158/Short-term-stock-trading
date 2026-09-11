"""Position-head adapter onto a common fee-adjusted R scale."""

from __future__ import annotations


HEAD_VERSION = "position-head.adapter-v1"


def position_values(expected_net_r, lower_bound_r, p_fill):
    expected = float(expected_net_r)
    lower = float(lower_bound_r)
    fill = max(0.0, min(1.0, float(p_fill)))
    downside = max(0.0, -lower)
    return {
        "schemaVersion": "portfolio-action-values.v1",
        "addRelativeToHoldR": expected,
        "holdR": expected,
        "reduceRelativeToHoldR": -expected * 0.5 + downside * 0.25,
        "exitRelativeToHoldR": -expected + downside * 0.5,
        "addExecutionAdjustedR": fill * expected,
        "source": "CURRENT_PRODUCTION_HEAD_ADAPTER",
    }
