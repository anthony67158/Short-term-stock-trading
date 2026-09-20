from platform_app.modules.experiments.multifactor_features import (
    FACTOR_FAMILIES,
    MODEL_FEATURE_NAMES,
    build_multifactor_metrics,
    build_price_factor_inputs,
    factor_feature_vector,
    score_multifactor_cross_section,
)


def _stock(code, *, strong):
    if strong:
        return {
            "code": code,
            "industry": "BANK",
            "logFloatMarketCap": 10,
            "peTtm": 8,
            "pb": 0.9,
            "psTtm": 1.2,
            "roeWaa": 16,
            "netProfitMargin": 24,
            "operatingCashToSales": 30,
            "debtToAssets": 45,
            "netProfitYoY": 18,
            "revenueYoY": 12,
            "adjustedReturn20": 0.12,
            "adjustedReturn60": 0.2,
            "adjustedReturn120Ex5": 0.28,
            "dividendYieldTtm": 4.2,
            "dividendContinuity3Y": 1,
            "realizedVolatility20": 0.012,
            "realizedVolatility60": 0.015,
            "downsideVolatility60": 0.009,
        }
    return {
        "code": code,
        "industry": "BANK",
        "logFloatMarketCap": 10,
        "peTtm": 40,
        "pb": 6,
        "psTtm": 8,
        "roeWaa": 3,
        "netProfitMargin": 2,
        "operatingCashToSales": -10,
        "debtToAssets": 85,
        "netProfitYoY": -20,
        "revenueYoY": -8,
        "adjustedReturn20": -0.1,
        "adjustedReturn60": -0.2,
        "adjustedReturn120Ex5": -0.25,
        "dividendYieldTtm": 0,
        "dividendContinuity3Y": 0,
        "realizedVolatility20": 0.05,
        "realizedVolatility60": 0.06,
        "downsideVolatility60": 0.055,
    }


def test_six_factor_score_preserves_expected_directions():
    rows = [
        build_multifactor_metrics(_stock("SH.600001", strong=True)),
        build_multifactor_metrics(_stock("SH.600002", strong=False)),
    ]

    scored = score_multifactor_cross_section(rows)
    by_code = {row["code"]: row for row in scored}

    assert tuple(by_code["SH.600001"]["factorScores"]) == FACTOR_FAMILIES
    assert by_code["SH.600001"]["state"] == "READY"
    assert by_code["SH.600001"]["rankPercentile"] == 1
    assert by_code["SH.600002"]["rankPercentile"] == 0
    assert all(
        by_code["SH.600001"]["factorScores"][name]
        > by_code["SH.600002"]["factorScores"][name]
        for name in FACTOR_FAMILIES
    )
    assert len(factor_feature_vector(by_code["SH.600001"])) == len(
        MODEL_FEATURE_NAMES
    )


def test_non_positive_valuation_is_missing_and_insufficient_families_are_ood():
    metrics = build_multifactor_metrics({
        "code": "SH.600003",
        "peTtm": -3,
        "pb": 0,
        "psTtm": None,
        "adjustedReturn20": 0.03,
        "adjustedReturn60": 0.05,
        "adjustedReturn120Ex5": 0.08,
        "realizedVolatility20": 0.02,
        "realizedVolatility60": 0.025,
        "downsideVolatility60": 0.018,
    })

    assert metrics["metrics"]["earningsYieldTtm"] is None
    assert metrics["metrics"]["bookToPrice"] is None
    assert metrics["metrics"]["salesYieldTtm"] is None

    [scored] = score_multifactor_cross_section([metrics])

    assert scored["state"] == "OOD"
    assert scored["reasonCode"] == "FACTOR_COVERAGE_INSUFFICIENT"
    assert scored["rankPercentile"] is None


def test_price_factors_use_trailing_adjusted_prices():
    prices = [100 + index for index in range(130)]

    factors = build_price_factor_inputs(prices)

    assert factors["adjustedReturn20"] == prices[-1] / prices[-21] - 1
    assert factors["adjustedReturn60"] == prices[-1] / prices[-61] - 1
    assert factors["adjustedReturn120Ex5"] == prices[-6] / prices[-121] - 1
    assert factors["realizedVolatility20"] > 0
    assert factors["realizedVolatility60"] > 0
    assert factors["downsideVolatility60"] == 0


def test_metric_scores_remove_large_industry_level_shift():
    rows = []
    for industry, offset in (("A", 100), ("B", 0)):
        for rank in range(8):
            item = build_multifactor_metrics(
                _stock(f"{industry}{rank}", strong=True)
            )
            item["industry"] = industry
            item["metrics"]["earningsYieldTtm"] = offset + rank
            rows.append(item)

    scored = score_multifactor_cross_section(rows)
    by_code = {row["code"]: row for row in scored}

    assert abs(
        by_code["A7"]["metricScores"]["earningsYieldTtm"]
        - by_code["B7"]["metricScores"]["earningsYieldTtm"]
    ) < 0.1
