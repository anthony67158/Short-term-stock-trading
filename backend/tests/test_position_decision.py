import json
from datetime import timedelta

import pytest
from pydantic import ValidationError

from platform_app.contracts.base import utcnow
from platform_app.modules.decisions.position_contracts import (
    ActionValueEstimate,
    HardRiskState,
    JointReleaseReference,
    PositionAssessment,
    PositionConstraints,
    PositionDecisionRequest,
    PositionEvidenceSignal,
    PositionValueReference,
)
from platform_app.modules.decisions.position_engine import arbitrate_position
from platform_app.modules.experiments.joint_bundle import (
    AGENT_FEATURE_NAMES,
    JointBundle,
    JointBundleError,
)
from platform_app.modules.research.contracts import Claim


def action_value(action, target, expected, q10, q50, q90, *, hazard=0.2):
    is_trade = action != "HOLD"
    return ActionValueEstimate(
        action=action,
        target_quantity_shares=target,
        expected_delta_return_vs_hold=expected,
        q10_delta_return_vs_hold=q10,
        q50_delta_return_vs_hold=q50,
        q90_delta_return_vs_hold=q90,
        stop_hazard=hazard,
        support=0.8,
        execution_path="LIMIT_BAND" if is_trade else None,
        price_lower="9.80" if is_trade else None,
        price_upper="10.20" if is_trade else None,
        price_basis="SNAPSHOT_PRICE" if is_trade else None,
        trigger_conditions=["价格处于注册区间"] if is_trade else [],
        estimated_costs="5.00" if is_trade else "0",
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
        horizon_end_date=(now + timedelta(days=7)).date(),
        market_snapshot_ref="synthetic-market-snapshot",
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


def decision_request(
    now=None,
    *,
    release_status="READY",
    thesis_status="SUPPORTED",
    hard_stop=False,
    sellable=1000,
):
    now = now or utcnow()
    blockers = [] if release_status == "READY" else ["JOINT_ABLATION_PENDING"]
    has_components = release_status in {"READY", "SHADOW"}
    return PositionDecisionRequest(
        decision_id="decision-1",
        context_id="context-1",
        as_of=now,
        valid_until=now + timedelta(minutes=10),
        release=JointReleaseReference(
            release_id="joint-v1",
            status=release_status,
            allows_new_risk=release_status == "READY",
            ranking_model_bundle_id="ranking-v1" if has_components else None,
            ranking_model_artifact_sha256="b" * 64 if has_components else None,
            quant_model_bundle_id="quant-v1" if has_components else None,
            quant_model_artifact_sha256="c" * 64 if has_components else None,
            position_model_bundle_id="position-v1" if has_components else None,
            position_model_artifact_sha256="a" * 64 if has_components else None,
            agent_protocol_version="position-assessment.v1" if has_components else None,
            blocker_codes=blockers,
        ),
        constraints=PositionConstraints(
            account_id="account-1",
            account_kind="SIMULATED",
            account_version=3,
            instrument_id="SZ.000001",
            current_quantity_shares=1000,
            sellable_quantity_shares=sellable,
            max_target_quantity_shares=1200,
            lot_size_shares=100,
            allowed_actions={"HOLD", "ADD", "REDUCE", "EXIT"},
            quantity_rule_version="a-share-lot-v1",
            fee_policy_version="fees-v1",
        ),
        hard_risk=HardRiskState(
            policy_version="risk-v1",
            source_snapshot_id="risk-snapshot-1",
            as_of=now - timedelta(seconds=5),
            valid_until=now + timedelta(minutes=1),
            hard_stop_triggered=hard_stop,
            reason_codes=["STOP_PRICE_BREACHED"] if hard_stop else [],
            execution_path="MARKETABLE_LIMIT" if hard_stop else None,
            price_lower="9.50" if hard_stop else None,
            price_upper="9.80" if hard_stop else None,
            price_basis="LIMIT_BAND_AT_RISK_SNAPSHOT" if hard_stop else None,
            trigger_conditions=["硬止损价格已触发"] if hard_stop else [],
            estimated_costs="8.00" if hard_stop else "0",
        ),
        quant=value_reference(now),
        agent=position_assessment(now, thesis_status=thesis_status),
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


def test_unreleased_joint_bundle_is_none_not_hold():
    decision = arbitrate_position(decision_request(release_status="UNAVAILABLE"))
    assert decision.status == "UNAVAILABLE"
    assert decision.action == "NONE"
    assert decision.target_quantity_shares is None
    assert decision.reason_codes == ["JOINT_ABLATION_PENDING"]


def test_hard_stop_preempts_unavailable_joint_bundle_and_uses_sellable_quantity():
    request = decision_request(
        release_status="UNAVAILABLE",
        hard_stop=True,
        sellable=600,
    )
    decision = arbitrate_position(request)
    assert decision.status == "READY"
    assert decision.action == "REDUCE"
    assert decision.target_quantity_shares == 400
    assert decision.delta_quantity_shares == -600
    assert decision.model_prediction_ref is None
    assert decision.agent_contribution_ref is None
    assert decision.execution_path == "MARKETABLE_LIMIT"
    assert decision.valid_until == request.hard_risk.valid_until


def test_hard_stop_without_sellable_shares_preserves_unavailable_state():
    decision = arbitrate_position(
        decision_request(hard_stop=True, sellable=0)
    )
    assert decision.status == "UNAVAILABLE"
    assert decision.action == "NONE"
    assert "HARD_STOP_EXECUTION_BLOCKED" in decision.reason_codes


def test_ready_joint_decision_selects_feasible_quant_value_with_agent_gate():
    decision = arbitrate_position(decision_request())
    assert decision.status == "READY"
    assert decision.action == "ADD"
    assert decision.target_quantity_shares == 1200
    assert decision.expected_delta_return_vs_hold == 0.03
    assert decision.q10_delta_return_vs_hold == -0.02
    assert decision.q90_delta_return_vs_hold == 0.08
    assert decision.stop_hazard == 0.2
    assert decision.quant_trend == "BULLISH"
    assert decision.agent_thesis_status == "SUPPORTED"
    assert decision.execution_path == "LIMIT_BAND"
    assert decision.assessment_ids == ["assessment-1"]
    assert decision.evidence_ids == ["evidence-1"]


def test_agent_quant_conflict_does_not_expand_risk():
    decision = arbitrate_position(
        decision_request(thesis_status="WEAKENED")
    )
    assert decision.status == "UNAVAILABLE"
    assert decision.action == "NONE"
    assert decision.reason_codes == ["AGENT_QUANT_CONFLICT_REQUIRES_REVIEW"]


def test_shadow_release_runs_only_for_simulated_accounts():
    simulated = arbitrate_position(decision_request(release_status="SHADOW"))
    assert simulated.status == "READY"
    assert simulated.action == "ADD"
    request = decision_request(release_status="SHADOW")
    request = request.model_copy(
        update={
            "constraints": request.constraints.model_copy(
                update={"account_kind": "REAL"}
            )
        }
    )
    real = arbitrate_position(request)
    assert real.status == "UNAVAILABLE"
    assert real.reason_codes == ["SHADOW_RELEASE_SIMULATION_ONLY"]


def test_future_available_agent_signal_fails_closed():
    request = decision_request()
    raw = request.agent.model_dump()
    raw["signals"][0]["published_at"] = request.as_of + timedelta(seconds=1)
    raw["signals"][0]["first_seen_at"] = request.as_of + timedelta(seconds=2)
    raw["signals"][0]["available_at"] = request.as_of + timedelta(seconds=3)
    with pytest.raises(ValidationError, match="评估时点后"):
        PositionAssessment.model_validate(raw)


def test_joint_bundle_binds_runtime_position_release(tmp_path):
    root = tmp_path / "joint"
    root.mkdir()
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "bundleId": "joint-v1",
                "schemaVersion": "joint-bundle.v1",
                "releaseStatus": "UNAVAILABLE",
                "releaseBlockers": ["JOINT_ABLATION_PENDING"],
                "components": {
                    "positionModelBundleId": "position-v1",
                    "positionModelArtifactSha256": "a" * 64,
                },
                "agent": {
                    "promptSha256": "b" * 64,
                    "featureNames": AGENT_FEATURE_NAMES,
                    "positionProtocolVersion": "position-assessment.v1",
                },
                "missingArtifacts": ["trained-joint-model"],
            }
        )
    )
    bundle = JointBundle(root, require_ready=False)
    request = decision_request(release_status="UNAVAILABLE").model_copy(
        update={"release": bundle.position_release()}
    )
    assert bundle.arbitrate_position(request).action == "NONE"
    with pytest.raises(JointBundleError, match="JOINT_RELEASE_REFERENCE_MISMATCH"):
        bundle.arbitrate_position(
            request.model_copy(
                update={
                    "release": request.release.model_copy(
                        update={"release_id": "forged-release"}
                    )
                }
            )
        )
