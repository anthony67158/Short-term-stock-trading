from datetime import timedelta

import pytest
from pydantic import ValidationError

from platform_app.contracts.base import utcnow
from platform_app.modules.decisions.position_contracts import (
    ActionValueEstimate,
    PositionAssessment,
    PositionEvidenceSignal,
    PositionValueReference,
)
from platform_app.modules.research.contracts import Claim


def action_value(action, target, expected, q10, q50, q90, *, hazard=0.2):
    return ActionValueEstimate(
        action=action,
        target_quantity_shares=target,
        expected_delta_return_vs_hold=expected,
        q10_delta_return_vs_hold=q10,
        q50_delta_return_vs_hold=q50,
        q90_delta_return_vs_hold=q90,
        stop_hazard=hazard,
        support=0.8,
    )


def value_reference(now=None):
    now = now or utcnow()
    return PositionValueReference(
        model_bundle_id="position-v1",
        model_artifact_sha256="a" * 64,
        feature_schema_version="position-features.v1",
        context_id="context-1",
        account_id="account-1",
        account_version=3,
        instrument_id="SZ.000001",
        as_of=now,
        valid_until=now + timedelta(minutes=15),
        horizon="5_TRADING_DAYS",
        trend="BULLISH",
        current_quantity_shares=1000,
        values=[
            action_value("HOLD", 1000, 0, 0, 0, 0),
            action_value("ADD", 1200, 0.03, -0.02, 0.02, 0.08),
            action_value("REDUCE", 500, -0.01, -0.04, -0.01, 0.03),
            action_value("EXIT", 0, -0.02, -0.05, -0.02, 0.01),
        ],
        cost_assumptions_ref="fees-v1",
        calibration_ref="position-calibration-v1",
    )


def position_assessment(now=None, *, thesis_status="SUPPORTED"):
    now = now or utcnow()
    evidence_id = "evidence-1"
    return PositionAssessment(
        assessment_id="assessment-1",
        model_id="gpt-synthetic",
        source_snapshot_id="snapshot-1",
        context_id="context-1",
        account_id="account-1",
        account_version=3,
        instrument_id="SZ.000001",
        as_of=now,
        valid_until=now + timedelta(minutes=15),
        thesis_status=thesis_status,
        claims=[
            Claim(
                kind="OBSERVED",
                statement="合成主力资金指标显示净流入，仅用于合同测试。",
                evidence_ids=[evidence_id],
            )
        ],
        counter_claims=[],
        signals=[
            PositionEvidenceSignal(
                evidence_id=evidence_id,
                category="MAIN_FLOW",
                direction="POSITIVE",
                statement="合成主力资金指标显示净流入，仅用于合同测试。",
                source_id="vendor-record-1",
                provider="synthetic-vendor",
                methodology="供应商按主动买卖方向聚合的合成推导指标。",
                published_at=now - timedelta(minutes=3),
                first_seen_at=now - timedelta(minutes=2),
                available_at=now - timedelta(minutes=1),
                validation="VENDOR_DERIVED",
            )
        ],
        uncertainties=["供应商口径不代表真实主力身份"],
        invalidation_conditions=["后续核验显示口径或数据错误"],
        review_after=now + timedelta(minutes=10),
    )


def test_position_contract_requires_complete_zero_based_action_vector():
    reference = value_reference()
    assert {value.action for value in reference.values} == {
        "HOLD",
        "ADD",
        "REDUCE",
        "EXIT",
    }
    invalid = reference.model_dump()
    invalid["values"][0]["expected_delta_return_vs_hold"] = 0.01
    with pytest.raises(ValidationError, match="HOLD"):
        PositionValueReference.model_validate(invalid)


def test_position_assessment_preserves_vendor_methodology_and_causal_time():
    assessment = position_assessment()
    assert assessment.signals[0].validation == "VENDOR_DERIVED"
    assert assessment.signals[0].methodology
    invalid = assessment.model_dump()
    invalid["signals"][0]["available_at"] = (
        assessment.signals[0].published_at - timedelta(seconds=1)
    )
    with pytest.raises(ValidationError, match="证据时间"):
        PositionAssessment.model_validate(invalid)
