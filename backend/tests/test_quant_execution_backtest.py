from platform_app.modules.experiments.quant_execution_backtest import (
    _cohort_metrics,
    _is_non_decreasing,
    _quantile_diagnostics,
)


def _row(index, *, utility, actual, stressed, filled=True):
    return {
        "decisionDate": f"202501{index + 1:02d}",
        "instrumentId": f"SH.{600000 + index}",
        "pFillLabel": int(filled),
        "pFullFillLabel": int(filled),
        "actualReturnOnRequestedCapital": actual,
        "actualReturnAt10BpsStress": stressed,
        "predictedUtilityAt10BpsStress": utility,
        "q10": -0.02,
        "q90": 0.04,
        "netReturnGivenFill": actual if filled else None,
        "exitReason": "TERMINAL" if filled else "NO_FILL",
    }


def test_cohort_metrics_include_no_fill_and_conditional_interval_coverage():
    rows = [
        _row(0, utility=0.02, actual=0.03, stressed=0.029),
        _row(1, utility=-0.01, actual=0.0, stressed=0.0, filled=False),
    ]

    metrics = _cohort_metrics(rows)

    assert metrics["selections"] == 2
    assert metrics["filled"] == 1
    assert metrics["fillRate"] == 0.5
    assert metrics["meanReturnOnRequestedCapital"] == 0.015
    assert metrics["meanReturnAt10BpsStress"] == 0.0145
    assert metrics["q10Q90CoverageGivenFill"] == 1
    assert metrics["exitReasons"] == {"NO_FILL": 1, "TERMINAL": 1}


def test_quantile_diagnostics_order_low_to_high_predicted_utility():
    rows = [
        _row(
            index,
            utility=float(9 - index),
            actual=float(9 - index) / 100,
            stressed=float(9 - index) / 100,
        )
        for index in range(10)
    ]

    buckets = _quantile_diagnostics(rows)

    assert [bucket["bucket"] for bucket in buckets] == [1, 2, 3, 4, 5]
    assert (
        buckets[0]["meanReturnAt10BpsStress"]
        < buckets[-1]["meanReturnAt10BpsStress"]
    )
    assert _is_non_decreasing([0.01, 0.02, 0.02])
    assert not _is_non_decreasing([0.01, -0.01, 0.03])
