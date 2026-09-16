"""Comparable-cycle monitoring for model, Agent protocol and outcomes."""

import hashlib
import json
from collections import Counter
from datetime import date
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select

from platform_app.adapters.database import sessions
from platform_app.modules.learning.models import (
    ProspectiveOutcome,
    ProspectiveSample,
)
from platform_app.modules.review.contracts import (
    CycleDriftReportPage,
    CycleDriftReportView,
)
from platform_app.modules.review.models import CycleDriftReport

MEAN_RETURN_DRIFT_THRESHOLD = Decimal("0.03")
NEGATIVE_RATE_DRIFT_THRESHOLD = Decimal("0.20")
ACTION_MIX_DRIFT_THRESHOLD = Decimal("0.25")


class DriftError(ValueError):
    pass


def _text(value: Decimal) -> str:
    rendered = format(value.quantize(Decimal("0.00000001")), "f")
    return "0.00000000" if rendered == "-0.00000000" else rendered


def _decimal(value: object) -> Decimal:
    if not isinstance(value, str):
        raise DriftError("DRIFT_OUTCOME_INVALID")
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise DriftError("DRIFT_OUTCOME_INVALID") from exc
    if not parsed.is_finite():
        raise DriftError("DRIFT_OUTCOME_INVALID")
    return parsed


def _selected_action(sample: ProspectiveSample) -> str:
    action = sample.scenario.get("selectedAction")
    if action in {"NONE", "WAIT"}:
        return "HOLD"
    if action not in {"HOLD", "ADD", "REDUCE", "EXIT"}:
        raise DriftError("DRIFT_SAMPLE_ACTION_INVALID")
    return action


def _cohort_signature(
    sample: ProspectiveSample,
    outcome: ProspectiveOutcome,
) -> dict:
    return {
        "horizon": sample.quant_prediction.get(
            "horizon",
            "5_TRADING_DAYS",
        ),
        "sampleSchemaVersion": sample.schema_version,
        "quantBundleId": sample.quant_bundle_id,
        "agentProtocolVersion": sample.agent_protocol_version,
        "agentFeatureSchemaVersion": (
            sample.agent_feature_schema_version
        ),
        "simulationPolicyVersion": outcome.simulation_policy_version,
        "sourceDatasetId": outcome.source_dataset_id,
    }


def _cycle_metrics(
    rows: list[tuple[ProspectiveSample, ProspectiveOutcome]],
) -> dict:
    returns = []
    actions = Counter()
    signatures = {}
    sample_ids = []
    for sample, outcome in rows:
        action = _selected_action(sample)
        raw_returns = outcome.simulation_outcome.get("actionNetReturns")
        if not isinstance(raw_returns, dict) or action not in raw_returns:
            raise DriftError("DRIFT_OUTCOME_INVALID")
        returns.append(_decimal(raw_returns[action]))
        actions[action] += 1
        signature = _cohort_signature(sample, outcome)
        signature_key = hashlib.sha256(
            json.dumps(
                signature,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        signatures[signature_key] = signature
        if len(sample_ids) < 50:
            sample_ids.append(sample.id)
    count = len(rows)
    return {
        "sampleCount": count,
        "meanSelectedNetReturn": (
            sum(returns, Decimal(0)) / count
            if count
            else None
        ),
        "negativeRate": (
            Decimal(sum(value < 0 for value in returns)) / count
            if count
            else None
        ),
        "actionRates": {
            action: (
                Decimal(actions[action]) / count
                if count
                else Decimal(0)
            )
            for action in ("HOLD", "ADD", "REDUCE", "EXIT")
        },
        "cohorts": signatures,
        "sourceSampleIds": sample_ids,
    }


def _metric(
    metric_id: str,
    baseline: Decimal | None,
    current: Decimal | None,
    threshold: Decimal | None,
) -> dict:
    delta = (
        current - baseline
        if baseline is not None and current is not None
        else None
    )
    return {
        "metricId": metric_id,
        "baselineValue": _text(baseline) if baseline is not None else None,
        "currentValue": _text(current) if current is not None else None,
        "delta": _text(delta) if delta is not None else None,
        "threshold": _text(threshold) if threshold is not None else None,
        "drifted": (
            abs(delta) > threshold
            if delta is not None and threshold is not None
            else None
        ),
    }


def build_drift_result(
    *,
    baseline_date: date | None,
    current_date: date,
    baseline_rows: list[
        tuple[ProspectiveSample, ProspectiveOutcome]
    ],
    current_rows: list[
        tuple[ProspectiveSample, ProspectiveOutcome]
    ],
    minimum_samples: int,
) -> dict:
    baseline = _cycle_metrics(baseline_rows)
    current = _cycle_metrics(current_rows)
    blockers = []
    if baseline_date is None:
        blockers.append("BASELINE_CYCLE_MISSING")
    if baseline["sampleCount"] < minimum_samples:
        blockers.append("BASELINE_SAMPLE_SUPPORT_INSUFFICIENT")
    if current["sampleCount"] < minimum_samples:
        blockers.append("CURRENT_SAMPLE_SUPPORT_INSUFFICIENT")
    if len(baseline["cohorts"]) > 1 or len(current["cohorts"]) > 1:
        blockers.append("MULTIPLE_COHORTS_WITHIN_CYCLE")
    elif (
        baseline["cohorts"]
        and current["cohorts"]
        and baseline["cohorts"] != current["cohorts"]
    ):
        blockers.append("PROTOCOL_OR_MODEL_DRIFT")
    action_delta = (
        max(
            abs(
                current["actionRates"][action]
                - baseline["actionRates"][action]
            )
            for action in ("HOLD", "ADD", "REDUCE", "EXIT")
        )
        if baseline_rows and current_rows
        else None
    )
    metrics = [
        _metric(
            "mean-selected-net-return",
            baseline["meanSelectedNetReturn"],
            current["meanSelectedNetReturn"],
            MEAN_RETURN_DRIFT_THRESHOLD,
        ),
        _metric(
            "negative-return-rate",
            baseline["negativeRate"],
            current["negativeRate"],
            NEGATIVE_RATE_DRIFT_THRESHOLD,
        ),
        _metric(
            "maximum-action-rate-shift",
            Decimal(0) if action_delta is not None else None,
            action_delta,
            ACTION_MIX_DRIFT_THRESHOLD,
        ),
    ]
    if blockers:
        status = "UNSUPPORTED"
    elif any(metric["drifted"] for metric in metrics):
        status = "WARNING"
    else:
        status = "STABLE"
    comparison_payload = {
        "baselineDate": (
            baseline_date.isoformat() if baseline_date else None
        ),
        "currentDate": current_date.isoformat(),
        "baselineCohorts": baseline["cohorts"],
        "currentCohorts": current["cohorts"],
    }
    return {
        "status": status,
        "comparisonKey": hashlib.sha256(
            json.dumps(
                comparison_payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest(),
        "metrics": metrics,
        "blockerCodes": blockers,
        "cycleSupport": [
            {
                "horizon": "5_TRADING_DAYS",
                "status": (
                    "ACTIVE"
                    if current["sampleCount"]
                    else "UNSUPPORTED"
                ),
                "reasonCode": (
                    None
                    if current["sampleCount"]
                    else "CURRENT_CYCLE_MISSING"
                ),
            },
            {
                "horizon": "20_TRADING_DAYS",
                "status": "UNSUPPORTED",
                "reasonCode": "SECOND_HORIZON_MODEL_NOT_TRAINED",
            },
        ],
        "baselineSourceSampleIds": baseline["sourceSampleIds"],
        "currentSourceSampleIds": current["sourceSampleIds"],
    }


def create_cycle_drift_report(
    owner_id: str,
    current_date: date,
    *,
    minimum_samples: int = 30,
) -> CycleDriftReportView:
    if minimum_samples < 1:
        raise DriftError("DRIFT_MINIMUM_SAMPLE_INVALID")
    with sessions().begin() as db:
        existing = db.scalar(
            select(CycleDriftReport).where(
                CycleDriftReport.owner_id == owner_id,
                CycleDriftReport.current_date == current_date,
            )
        )
        if existing:
            return CycleDriftReportView.model_validate(existing)
        baseline_date = db.scalar(
            select(func.max(ProspectiveSample.horizon_end_date)).where(
                ProspectiveSample.owner_id == owner_id,
                ProspectiveSample.status == "MATURED",
                ProspectiveSample.horizon_end_date < current_date,
            )
        )

        def rows_for(day: date | None):
            if day is None:
                return []
            return list(
                db.execute(
                    select(ProspectiveSample, ProspectiveOutcome)
                    .join(
                        ProspectiveOutcome,
                        ProspectiveOutcome.sample_id
                        == ProspectiveSample.id,
                    )
                    .where(
                        ProspectiveSample.owner_id == owner_id,
                        ProspectiveSample.status == "MATURED",
                        ProspectiveSample.horizon_end_date == day,
                    )
                    .order_by(ProspectiveSample.id)
                )
            )

        baseline_rows = rows_for(baseline_date)
        current_rows = rows_for(current_date)
        result = build_drift_result(
            baseline_date=baseline_date,
            current_date=current_date,
            baseline_rows=baseline_rows,
            current_rows=current_rows,
            minimum_samples=minimum_samples,
        )
        report = CycleDriftReport(
            owner_id=owner_id,
            baseline_date=baseline_date,
            current_date=current_date,
            status=result["status"],
            comparison_key=result["comparisonKey"],
            metrics=result["metrics"],
            blocker_codes=result["blockerCodes"],
            cycle_support=result["cycleSupport"],
        )
        db.add(report)
        db.flush()
        return CycleDriftReportView.model_validate(report)


def drift_reports(
    owner_id: str,
    limit: int,
) -> CycleDriftReportPage:
    with sessions()() as db:
        rows = list(
            db.scalars(
                select(CycleDriftReport)
                .where(CycleDriftReport.owner_id == owner_id)
                .order_by(
                    CycleDriftReport.current_date.desc(),
                    CycleDriftReport.id.desc(),
                )
                .limit(limit)
            )
        )
        return CycleDriftReportPage(
            reports=[
                CycleDriftReportView.model_validate(row)
                for row in rows
            ]
        )
