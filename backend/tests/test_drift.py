from datetime import date
from types import SimpleNamespace

from platform_app.contracts.base import new_id
from platform_app.modules.review.drift import build_drift_result


def _row(
    net_return: str,
    *,
    action: str = "ADD",
    quant_bundle: str = "quant-v1",
    protocol: str = "position-assessment.v1",
):
    sample = SimpleNamespace(
        id=new_id(),
        scenario={"selectedAction": action},
        quant_prediction={"horizon": "5_TRADING_DAYS"},
        schema_version="prospective-position-sample.v1",
        quant_bundle_id=quant_bundle,
        agent_protocol_version=protocol,
        agent_feature_schema_version="position-agent-features.v1",
    )
    outcome = SimpleNamespace(
        simulation_policy_version="prospective-position-outcome.v1",
        source_dataset_id="market-v5",
        simulation_outcome={
            "actionNetReturns": {
                "HOLD": "0",
                "ADD": net_return,
                "REDUCE": "-0.01",
                "EXIT": "-0.02",
            }
        },
    )
    return sample, outcome


def test_drift_compares_only_same_horizon_and_protocol():
    baseline = [_row("0.01"), _row("0.02")]
    current = [_row("0.015"), _row("0.025")]

    result = build_drift_result(
        baseline_date=date(2026, 9, 8),
        current_date=date(2026, 9, 15),
        baseline_rows=baseline,
        current_rows=current,
        minimum_samples=2,
    )

    assert result["status"] == "STABLE"
    assert result["blockerCodes"] == []
    assert result["cycleSupport"][0]["status"] == "ACTIVE"
    assert result["cycleSupport"][1] == {
        "horizon": "20_TRADING_DAYS",
        "status": "UNSUPPORTED",
        "reasonCode": "SECOND_HORIZON_MODEL_NOT_TRAINED",
    }


def test_drift_exposes_protocol_change_as_unsupported():
    result = build_drift_result(
        baseline_date=date(2026, 9, 8),
        current_date=date(2026, 9, 15),
        baseline_rows=[_row("0.01"), _row("0.02")],
        current_rows=[
            _row("0.01", protocol="position-assessment.v2"),
            _row("0.02", protocol="position-assessment.v2"),
        ],
        minimum_samples=2,
    )

    assert result["status"] == "UNSUPPORTED"
    assert result["blockerCodes"] == ["PROTOCOL_OR_MODEL_DRIFT"]


def test_drift_warns_on_material_return_and_action_shift():
    result = build_drift_result(
        baseline_date=date(2026, 9, 8),
        current_date=date(2026, 9, 15),
        baseline_rows=[_row("0.05"), _row("0.05")],
        current_rows=[
            _row("-0.05", action="EXIT"),
            _row("-0.05", action="EXIT"),
        ],
        minimum_samples=2,
    )

    assert result["status"] == "WARNING"
    assert {
        metric["metricId"]
        for metric in result["metrics"]
        if metric["drifted"]
    } == {
        "mean-selected-net-return",
        "negative-return-rate",
        "maximum-action-rate-shift",
    }
