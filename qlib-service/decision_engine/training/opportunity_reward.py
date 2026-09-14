"""Cost-aware opportunity reward shaping for the trigger-review ranker.

This module converts a realized fee-adjusted ``netR`` into a shaped reward that
also reflects turnover, minimum-commission drag, capital occupation and tail
losses. Every penalty defaults to ``0`` so the shaped reward equals the raw
``netR`` unless a caller explicitly opts in. This keeps the existing label
contract (``y_opportunity_r``) byte-for-byte identical until a challenger is
trained and validated through the champion/challenger gate.

The realized ``netR`` in the outcome ledger is already net of fees. The
penalties here are *incremental* shaping signals used only for training the
opportunity ranker, never for account bookkeeping.
"""

from __future__ import annotations

import math


REWARD_CONTRACT_VERSION = "opportunity-reward.v1"

# A single A-share round trip pays at least the 5 CNY minimum commission on both
# the buy and the sell leg when the traded notional is small.
MIN_COMMISSION_LEGS = 2
MIN_COMMISSION_CNY = 5.0


def _finite(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def minimum_commission_drag_r(metrics):
    """Extra R lost purely because small notional hits the 5 CNY floor.

    Returns ``0`` when the trade is large enough that the percentage commission
    already exceeds the floor, or when risk cash is unavailable.
    """
    risk_cash = _finite((metrics or {}).get("actualFillRiskCash"))
    if risk_cash is None:
        risk_cash = _finite((metrics or {}).get("initialRiskCash"))
    total_fees = _finite((metrics or {}).get("totalFees"))
    if risk_cash is None or total_fees is None or risk_cash <= 0:
        return 0.0
    floor = MIN_COMMISSION_LEGS * MIN_COMMISSION_CNY
    # Only the portion of fees that is *forced* by the floor beyond what a
    # percentage-only schedule would charge is treated as drag. When we cannot
    # separate the two we conservatively cap the drag at the floor itself.
    forced = min(total_fees, floor)
    return forced / risk_cash


def capital_occupation_r(metrics, *, daily_rate_r=0.0):
    """R-equivalent cost of tying up capital for the holding window.

    ``daily_rate_r`` is the opportunity cost per held trading session expressed
    in R. Defaults to ``0`` (no penalty).
    """
    rate = _finite(daily_rate_r) or 0.0
    if rate <= 0:
        return 0.0
    sessions = _finite((metrics or {}).get("holdingTradingSessions"))
    if sessions is None or sessions <= 0:
        return 0.0
    return rate * sessions


def tail_loss_r(metrics, *, mae_threshold_pct=None):
    """Non-negative tail severity in R-like units from max adverse excursion.

    ``maePct`` is stored as a signed percentage (negative = adverse). Only the
    portion beyond ``mae_threshold_pct`` counts. Defaults to ``None`` (off).
    """
    threshold = _finite(mae_threshold_pct)
    if threshold is None:
        return 0.0
    mae = _finite((metrics or {}).get("maePct"))
    if mae is None:
        return 0.0
    adverse = -mae if mae < 0 else 0.0
    excess = adverse - abs(threshold)
    return excess / 100.0 if excess > 0 else 0.0


def cost_aware_opportunity_reward(
    metrics,
    *,
    filled=True,
    base_r=None,
    turnover_penalty_r=0.0,
    min_commission_weight=0.0,
    capital_daily_rate_r=0.0,
    tail_weight=0.0,
    tail_threshold_pct=None,
):
    """Shape a filled opportunity's realized ``netR`` into a cost-aware reward.

    With all weights at their defaults the return value equals the raw
    ``netR`` (or ``base_r`` when provided), preserving the current label. An
    unfilled/triggered event contributes ``0`` exactly as today.
    """
    if not filled:
        return 0.0
    raw = _finite(base_r)
    if raw is None:
        raw = _finite((metrics or {}).get("netR"))
    if raw is None:
        return 0.0

    penalty = 0.0
    turnover = _finite(turnover_penalty_r) or 0.0
    if turnover > 0:
        penalty += turnover
    commission_weight = _finite(min_commission_weight) or 0.0
    if commission_weight > 0:
        penalty += commission_weight * minimum_commission_drag_r(metrics)
    penalty += capital_occupation_r(
        metrics,
        daily_rate_r=capital_daily_rate_r,
    )
    tail_w = _finite(tail_weight) or 0.0
    if tail_w > 0:
        penalty += tail_w * tail_loss_r(
            metrics,
            mae_threshold_pct=tail_threshold_pct,
        )
    return raw - penalty
