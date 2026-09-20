"""Transparent six-factor features shared by training and inference."""

from __future__ import annotations

import math

import numpy as np


FEATURE_SCHEMA_VERSION = "ashare-six-factor.v1"
FACTOR_FAMILIES = (
    "value",
    "quality",
    "growth",
    "momentum",
    "dividend",
    "lowVolatility",
)
FACTOR_METRICS = {
    "value": ("earningsYieldTtm", "bookToPrice", "salesYieldTtm"),
    "quality": (
        "roeWaa",
        "netProfitMargin",
        "operatingCashToSales",
        "debtToAssetsInverse",
    ),
    "growth": ("netProfitYoY", "revenueYoY"),
    "momentum": (
        "adjustedReturn20",
        "adjustedReturn60",
        "adjustedReturn120Ex5",
    ),
    "dividend": ("dividendYieldTtm", "dividendContinuity3Y"),
    "lowVolatility": (
        "realizedVolatility20Inverse",
        "realizedVolatility60Inverse",
        "downsideVolatility60Inverse",
    ),
}
METRIC_NAMES = tuple(
    metric for family in FACTOR_FAMILIES for metric in FACTOR_METRICS[family]
)
MODEL_FEATURE_NAMES = tuple(
    [f"factorScore_{family}" for family in FACTOR_FAMILIES]
    + [f"metricScore_{metric}" for metric in METRIC_NAMES]
)


def _finite(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _positive_inverse(value) -> float | None:
    number = _finite(value)
    return 1 / number if number is not None and number > 0 else None


def _negative(value) -> float | None:
    number = _finite(value)
    return -number if number is not None else None


def build_multifactor_metrics(row: dict) -> dict:
    """Normalize raw point-in-time values so a larger metric is always better."""

    metrics = {
        "earningsYieldTtm": _positive_inverse(row.get("peTtm")),
        "bookToPrice": _positive_inverse(row.get("pb")),
        "salesYieldTtm": _positive_inverse(row.get("psTtm")),
        "roeWaa": _finite(row.get("roeWaa")),
        "netProfitMargin": _finite(row.get("netProfitMargin")),
        "operatingCashToSales": _finite(row.get("operatingCashToSales")),
        "debtToAssetsInverse": _negative(row.get("debtToAssets")),
        "netProfitYoY": _finite(row.get("netProfitYoY")),
        "revenueYoY": _finite(row.get("revenueYoY")),
        "adjustedReturn20": _finite(row.get("adjustedReturn20")),
        "adjustedReturn60": _finite(row.get("adjustedReturn60")),
        "adjustedReturn120Ex5": _finite(row.get("adjustedReturn120Ex5")),
        "dividendYieldTtm": _finite(row.get("dividendYieldTtm")),
        "dividendContinuity3Y": _finite(row.get("dividendContinuity3Y")),
        "realizedVolatility20Inverse": _negative(
            row.get("realizedVolatility20")
        ),
        "realizedVolatility60Inverse": _negative(
            row.get("realizedVolatility60")
        ),
        "downsideVolatility60Inverse": _negative(
            row.get("downsideVolatility60")
        ),
    }
    return {
        "schemaVersion": FEATURE_SCHEMA_VERSION,
        "code": str(row.get("code") or ""),
        "industry": str(row.get("industry") or ""),
        "logFloatMarketCap": _finite(row.get("logFloatMarketCap")),
        "reportPeriod": str(row.get("reportPeriod") or "") or None,
        "reportAvailableAt": str(row.get("reportAvailableAt") or "") or None,
        "metrics": metrics,
    }


def build_price_factor_inputs(adjusted_closes) -> dict:
    prices = np.asarray(adjusted_closes, dtype=np.float64)
    if prices.ndim != 1 or len(prices) < 2 or not np.all(np.isfinite(prices)):
        raise ValueError("MULTIFACTOR_PRICE_HISTORY_INVALID")
    if np.any(prices <= 0):
        raise ValueError("MULTIFACTOR_PRICE_HISTORY_INVALID")
    returns = prices[1:] / prices[:-1] - 1

    def trailing_return(sessions: int) -> float | None:
        if len(prices) <= sessions:
            return None
        return float(prices[-1] / prices[-sessions - 1] - 1)

    def volatility(sessions: int) -> float | None:
        if len(returns) < sessions:
            return None
        return float(np.std(returns[-sessions:]))

    downside = None
    if len(returns) >= 60:
        downside = float(
            np.sqrt(np.mean(np.minimum(returns[-60:], 0) ** 2))
        )
    return {
        "adjustedReturn20": trailing_return(20),
        "adjustedReturn60": trailing_return(60),
        "adjustedReturn120Ex5": (
            float(prices[-6] / prices[-121] - 1)
            if len(prices) >= 121
            else None
        ),
        "realizedVolatility20": volatility(20),
        "realizedVolatility60": volatility(60),
        "downsideVolatility60": downside,
    }


def _percentiles(values: list[float]) -> np.ndarray:
    data = np.asarray(values, dtype=np.float64)
    if not len(data):
        return np.empty(0, dtype=np.float64)
    if len(data) == 1:
        return np.asarray([0.5], dtype=np.float64)
    lower, upper = np.quantile(data, (0.01, 0.99))
    clipped = np.clip(data, lower, upper)
    order = np.argsort(clipped, kind="stable")
    result = np.empty(len(data), dtype=np.float64)
    cursor = 0
    denominator = len(data) - 1
    while cursor < len(order):
        end = cursor + 1
        while end < len(order) and clipped[order[end]] == clipped[order[cursor]]:
            end += 1
        result[order[cursor:end]] = ((cursor + end - 1) / 2) / denominator
        cursor = end
    return result


def _neutralized_percentiles(
    rows: list[dict],
    indexes: list[int],
    values: list[float],
) -> np.ndarray:
    data = np.asarray(values, dtype=np.float64)
    if len(data) < 2:
        return _percentiles(values)
    lower, upper = np.quantile(data, (0.01, 0.99))
    clipped = np.clip(data, lower, upper)
    columns = [np.ones(len(indexes), dtype=np.float64)]

    sizes = np.asarray(
        [
            _finite(rows[index].get("logFloatMarketCap"))
            for index in indexes
        ],
        dtype=object,
    )
    if all(value is not None for value in sizes):
        numeric_sizes = sizes.astype(np.float64)
        if float(np.std(numeric_sizes)) > 1e-9:
            columns.append(numeric_sizes - float(np.mean(numeric_sizes)))

    industries = [str(rows[index].get("industry") or "") for index in indexes]
    counts = {
        industry: industries.count(industry)
        for industry in set(industries)
        if industry
    }
    eligible = sorted(
        industry for industry, count in counts.items() if count >= 5
    )
    for industry in eligible[1:]:
        columns.append(
            np.asarray(
                [1.0 if value == industry else 0.0 for value in industries],
                dtype=np.float64,
            )
        )
    design = np.column_stack(columns)
    residuals = clipped - design @ np.linalg.lstsq(
        design,
        clipped,
        rcond=None,
    )[0]
    return _percentiles(residuals.tolist())


def score_multifactor_cross_section(rows: list[dict]) -> list[dict]:
    """Score a decision-date cross section while preserving missing families."""

    normalized = [dict(row) for row in rows]
    metric_scores: dict[str, dict[int, float]] = {}
    for metric in {
        name for family in FACTOR_FAMILIES for name in FACTOR_METRICS[family]
    }:
        indexes = []
        values = []
        for index, row in enumerate(normalized):
            value = _finite((row.get("metrics") or {}).get(metric))
            if value is None:
                continue
            indexes.append(index)
            values.append(value)
        scores = _neutralized_percentiles(normalized, indexes, values)
        metric_scores[metric] = {
            index: float(scores[position])
            for position, index in enumerate(indexes)
        }

    result = []
    ready_indexes = []
    ready_scores = []
    for index, row in enumerate(normalized):
        factor_scores = {}
        missing_families = []
        for family in FACTOR_FAMILIES:
            metric_names = FACTOR_METRICS[family]
            available = [
                metric_scores[name][index]
                for name in metric_names
                if index in metric_scores[name]
            ]
            minimum = math.ceil(len(metric_names) / 2)
            if len(available) < minimum:
                factor_scores[family] = None
                missing_families.append(family)
            else:
                factor_scores[family] = float(np.mean(available))
        available_families = [
            value for value in factor_scores.values() if value is not None
        ]
        ready = len(available_families) >= 4
        composite = float(np.mean(available_families)) if ready else None
        item = {
            **row,
            "state": "READY" if ready else "OOD",
            "reasonCode": None if ready else "FACTOR_COVERAGE_INSUFFICIENT",
            "factorScores": factor_scores,
            "metricScores": {
                metric: metric_scores[metric].get(index)
                for metric in METRIC_NAMES
            },
            "factorContributions": {
                family: (
                    (value - 0.5) / len(available_families)
                    if ready and value is not None
                    else None
                )
                for family, value in factor_scores.items()
            },
            "availableFamilyCount": len(available_families),
            "missingFamilies": missing_families,
            "compositeScore": composite,
            "rankPercentile": None,
        }
        if ready:
            ready_indexes.append(len(result))
            ready_scores.append(composite)
        result.append(item)

    ranks = _percentiles(ready_scores)
    for position, result_index in enumerate(ready_indexes):
        result[result_index]["rankPercentile"] = float(ranks[position])
    return result


def factor_feature_vector(row: dict) -> np.ndarray:
    factor_scores = row.get("factorScores") or {}
    metric_scores = row.get("metricScores") or {}

    def value_or_nan(value):
        number = _finite(value)
        return number if number is not None else np.nan

    return np.asarray(
        [
            *[
                value_or_nan(factor_scores.get(family))
                for family in FACTOR_FAMILIES
            ],
            *[
                value_or_nan(metric_scores.get(metric))
                for metric in METRIC_NAMES
            ],
        ],
        dtype=np.float32,
    )
