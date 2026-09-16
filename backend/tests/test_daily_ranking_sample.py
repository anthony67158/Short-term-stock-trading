from decimal import Decimal

import pytest

from platform_app.modules.experiments.daily_ranking_sample import (
    build_daily_ranking_sample,
)


def _row(index, *, factor="1", amount="1000000"):
    close = Decimal("10") + Decimal(index) / Decimal("100")
    return {
        "open": str(close - Decimal("0.02")),
        "high": str(close + Decimal("0.05")),
        "low": str(close - Decimal("0.05")),
        "close": str(close),
        "previous_close": str(close - Decimal("0.01")),
        "amount_cny": amount,
        "factor": factor,
        "daily_available_at": f"2026-01-{index + 1:02d}T16:30:00+08:00",
        "factor_available_at": f"2026-01-{index + 1:02d}T16:30:00+08:00",
    }


def test_daily_ranking_sample_uses_only_history_for_features_and_future_for_outcomes():
    history = [_row(index) for index in range(61)]
    future = [_row(index + 61) for index in range(5)]

    sample = build_daily_ranking_sample(
        history=history,
        future=future,
        listing_age_days=200,
    )

    assert sample["featureSchemaVersion"] == "daily-ranking-features.v1"
    assert sample["features"]["listingAgeDays"] == "200"
    assert Decimal(sample["features"]["adjustedReturn60"]) == Decimal("0.06")
    assert Decimal(sample["features"]["medianAmount20Cny"]) == Decimal("1000000")
    assert Decimal(sample["outcomes"]["forwardReturnDecisionClose5"]) > 0
    assert Decimal(sample["outcomes"]["maximumAdverseExcursion5"]) < 0


def test_adjustment_factors_preserve_corporate_action_return_continuity():
    history = [_row(index) for index in range(61)]
    future = [_row(index + 61) for index in range(5)]
    future[-1]["close"] = str(Decimal(future[-1]["close"]) / Decimal("2"))
    future[-1]["high"] = str(Decimal(future[-1]["high"]) / Decimal("2"))
    future[-1]["low"] = str(Decimal(future[-1]["low"]) / Decimal("2"))
    future[-1]["factor"] = "2"

    sample = build_daily_ranking_sample(
        history=history,
        future=future,
        listing_age_days=200,
    )

    assert Decimal(sample["outcomes"]["forwardReturnDecisionClose5"]) > 0


def test_daily_ranking_sample_rejects_missing_or_non_positive_inputs():
    history = [_row(index) for index in range(61)]
    future = [_row(index + 61) for index in range(5)]
    history[-1]["amount_cny"] = "0"
    for row in history[-20:]:
        row["amount_cny"] = "0"

    with pytest.raises(ValueError, match="RANKING_NON_POSITIVE_LIQUIDITY"):
        build_daily_ranking_sample(
            history=history,
            future=future,
            listing_age_days=200,
        )
