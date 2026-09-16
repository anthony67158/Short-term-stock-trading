"""Point-in-time daily features and future outcomes for universe ranking."""

from decimal import Decimal, localcontext

HISTORY_SESSIONS = 61
HORIZON_SESSIONS = 5
FEATURE_SCHEMA_VERSION = "daily-ranking-features.v1"
OUTCOME_SCHEMA_VERSION = "daily-ranking-outcomes.v1"


def _decimal(value) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError("RANKING_NUMBER_INVALID")
    return result


def _text(value: Decimal) -> str:
    rendered = format(value.normalize(), "f")
    return "0" if rendered in {"", "-0"} else rendered


def _median(values: list[Decimal]) -> Decimal:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / Decimal(2)


def _volatility(prices: list[Decimal]) -> Decimal:
    returns = [
        prices[index] / prices[index - 1] - Decimal(1)
        for index in range(1, len(prices))
    ]
    mean = sum(returns, Decimal(0)) / Decimal(len(returns))
    variance = sum((value - mean) ** 2 for value in returns) / Decimal(
        len(returns)
    )
    return variance.sqrt()


def build_daily_ranking_sample(
    *,
    history: list[dict],
    future: list[dict],
    listing_age_days: int,
) -> dict:
    if (
        len(history) != HISTORY_SESSIONS
        or len(future) != HORIZON_SESSIONS
        or listing_age_days <= 0
    ):
        raise ValueError("RANKING_PATH_LENGTH_INVALID")
    if any(row.get("factor") is None for row in [*history, *future]):
        raise ValueError("RANKING_ADJUSTMENT_FACTOR_MISSING")

    with localcontext() as context:
        context.prec = 28
        adjusted_closes = [
            _decimal(row["close"]) * _decimal(row["factor"]) for row in history
        ]
        if any(price <= 0 for price in adjusted_closes):
            raise ValueError("RANKING_NON_POSITIVE_PRICE")
        amounts = [_decimal(row["amount_cny"]) for row in history]
        if any(amount < 0 for amount in amounts):
            raise ValueError("RANKING_NEGATIVE_AMOUNT")
        median_amount5 = _median(amounts[-5:])
        median_amount20 = _median(amounts[-20:])
        median_amount60 = _median(amounts[-60:])
        if median_amount20 <= 0:
            raise ValueError("RANKING_NON_POSITIVE_LIQUIDITY")

        decision = history[-1]
        previous_close = _decimal(decision["previous_close"])
        day_high = _decimal(decision["high"])
        day_low = _decimal(decision["low"])
        day_close = _decimal(decision["close"])
        if previous_close <= 0 or day_high <= 0 or day_low <= 0 or day_close <= 0:
            raise ValueError("RANKING_NON_POSITIVE_PRICE")
        ranges20 = [
            (_decimal(row["high"]) - _decimal(row["low"]))
            / _decimal(row["previous_close"])
            for row in history[-20:]
            if _decimal(row["previous_close"]) > 0
        ]
        if len(ranges20) != 20:
            raise ValueError("RANKING_NON_POSITIVE_PRICE")
        close_location = (
            (day_close - day_low) / (day_high - day_low)
            if day_high > day_low
            else Decimal("0.5")
        )
        latest = adjusted_closes[-1]
        features = {
            "adjustedReturn1": _text(latest / adjusted_closes[-2] - 1),
            "adjustedReturn5": _text(latest / adjusted_closes[-6] - 1),
            "adjustedReturn10": _text(latest / adjusted_closes[-11] - 1),
            "adjustedReturn20": _text(latest / adjusted_closes[-21] - 1),
            "adjustedReturn60": _text(latest / adjusted_closes[-61] - 1),
            "realizedVolatility5": _text(_volatility(adjusted_closes[-6:])),
            "realizedVolatility20": _text(_volatility(adjusted_closes[-21:])),
            "realizedVolatility60": _text(_volatility(adjusted_closes[-61:])),
            "drawdownFromHigh20": _text(
                latest / max(adjusted_closes[-20:]) - 1
            ),
            "distanceFromLow20": _text(
                latest / min(adjusted_closes[-20:]) - 1
            ),
            "medianAmount5Cny": _text(median_amount5),
            "medianAmount20Cny": _text(median_amount20),
            "medianAmount60Cny": _text(median_amount60),
            "amountToMedian20": _text(amounts[-1] / median_amount20),
            "meanRange20": _text(sum(ranges20, Decimal(0)) / Decimal(20)),
            "gap1": _text(_decimal(decision["open"]) / previous_close - 1),
            "closeLocation1": _text(close_location),
            "listingAgeDays": str(listing_age_days),
        }

        entry = _decimal(future[0]["open"]) * _decimal(future[0]["factor"])
        terminal = _decimal(future[-1]["close"]) * _decimal(future[-1]["factor"])
        future_lows = [
            _decimal(row["low"]) * _decimal(row["factor"]) for row in future
        ]
        future_highs = [
            _decimal(row["high"]) * _decimal(row["factor"]) for row in future
        ]
        if entry <= 0 or terminal <= 0 or min(future_lows) <= 0:
            raise ValueError("RANKING_NON_POSITIVE_FUTURE_PRICE")
        outcomes = {
            "forwardReturnDecisionClose5": _text(terminal / latest - 1),
            "forwardReturnNextOpen5": _text(terminal / entry - 1),
            "maximumAdverseExcursion5": _text(min(future_lows) / entry - 1),
            "maximumFavorableExcursion5": _text(max(future_highs) / entry - 1),
        }
    return {
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "outcomeSchemaVersion": OUTCOME_SCHEMA_VERSION,
        "featureAvailableAt": max(
            history[-1]["daily_available_at"],
            history[-1]["factor_available_at"],
        ),
        "features": features,
        "outcomes": outcomes,
    }
