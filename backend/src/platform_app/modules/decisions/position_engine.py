"""Deterministic risk and constraint arbitration for position decisions."""

from platform_app.modules.decisions.position_contracts import (
    ActionValueEstimate,
    PositionDecision,
    PositionDecisionRequest,
)

ACTION_ORDER = ("HOLD", "REDUCE", "EXIT", "ADD")


def _base(request: PositionDecisionRequest) -> dict:
    constraints = request.constraints
    return {
        "decision_id": request.decision_id,
        "account_id": constraints.account_id,
        "instrument_id": constraints.instrument_id,
        "context_id": request.context_id,
        "as_of": request.as_of,
        "valid_until": request.valid_until,
        "account_version": constraints.account_version,
        "release_id": request.release.release_id,
        "risk_policy_version": request.hard_risk.policy_version,
        "quantity_rule_version": constraints.quantity_rule_version,
        "fee_policy_version": constraints.fee_policy_version,
    }


def _unavailable(
    request: PositionDecisionRequest,
    *reason_codes: str,
    decision_reason: str,
) -> PositionDecision:
    agent = request.agent
    return PositionDecision(
        **_base(request),
        assessment_ids=[agent.assessment_id] if agent else [],
        status="UNAVAILABLE",
        action="NONE",
        reason_codes=list(dict.fromkeys(reason_codes)),
        evidence_ids=(
            list(dict.fromkeys(signal.evidence_id for signal in agent.signals))
            if agent
            else []
        ),
        decision_reason=decision_reason,
    )


def _risk_override(request: PositionDecisionRequest) -> PositionDecision:
    constraints = request.constraints
    sellable = constraints.sellable_quantity_shares
    if sellable == 0:
        return _unavailable(
            request,
            *request.hard_risk.reason_codes,
            "HARD_STOP_EXECUTION_BLOCKED",
            decision_reason="硬止损已触发，但当前没有可卖数量；保留风险提醒并等待可执行状态。",
        )
    target = constraints.current_quantity_shares - sellable
    action = "EXIT" if target == 0 else "REDUCE"
    return PositionDecision(
        **{
            **_base(request),
            "valid_until": min(request.valid_until, request.hard_risk.valid_until),
        },
        assessment_ids=[],
        status="READY",
        action=action,
        reason_codes=[
            "HARD_RISK_OVERRIDE",
            *request.hard_risk.reason_codes,
        ],
        evidence_ids=[],
        current_quantity_shares=constraints.current_quantity_shares,
        target_quantity_shares=target,
        delta_quantity_shares=-sellable,
        execution_path=request.hard_risk.execution_path,
        price_lower=request.hard_risk.price_lower,
        price_upper=request.hard_risk.price_upper,
        price_basis=request.hard_risk.price_basis,
        trigger_conditions=request.hard_risk.trigger_conditions,
        estimated_costs=request.hard_risk.estimated_costs,
        decision_reason="硬风险策略优先于模型与Agent，按当前可卖数量降低风险。",
    )


def _same_context(request: PositionDecisionRequest) -> bool:
    quant = request.quant
    agent = request.agent
    constraints = request.constraints
    if not quant or not agent:
        return False
    expected = (
        request.context_id,
        constraints.account_id,
        constraints.account_version,
        constraints.instrument_id,
    )
    return (
        quant.context_id,
        quant.account_id,
        quant.account_version,
        quant.instrument_id,
    ) == expected and (
        agent.context_id,
        agent.account_id,
        agent.account_version,
        agent.instrument_id,
    ) == expected


def _is_feasible(
    value: ActionValueEstimate,
    request: PositionDecisionRequest,
) -> bool:
    constraints = request.constraints
    current = constraints.current_quantity_shares
    target = value.target_quantity_shares
    if value.action not in constraints.allowed_actions:
        return False
    if value.action == "HOLD":
        return target == current
    if value.action == "ADD":
        return (
            current < target <= constraints.max_target_quantity_shares
            and (target - current) % constraints.lot_size_shares == 0
        )
    if value.action == "REDUCE":
        return current - constraints.sellable_quantity_shares <= target < current
    return value.action == "EXIT" and target == 0 and (
        constraints.sellable_quantity_shares == current
    )


def arbitrate_position(request: PositionDecisionRequest) -> PositionDecision:
    risk = request.hard_risk
    if not risk.as_of <= request.as_of < risk.valid_until:
        return _unavailable(
            request,
            "RISK_STATE_NOT_CAUSAL_OR_EXPIRED",
            decision_reason="风险快照不属于当前决策时点，不能发布持仓动作。",
        )
    if risk.hard_stop_triggered:
        return _risk_override(request)
    if request.release.status != "READY":
        return _unavailable(
            request,
            *request.release.blocker_codes,
            decision_reason="联合版本尚未通过发布门禁，不能输出生产持仓建议。",
        )
    if not request.quant or not request.agent:
        return _unavailable(
            request,
            "JOINT_INPUT_INCOMPLETE",
            decision_reason="量化动作价值或Agent持仓研判缺失。",
        )
    if not _same_context(request):
        return _unavailable(
            request,
            "DECISION_CONTEXT_MISMATCH",
            decision_reason="模型、Agent与账户快照并非同一个DecisionContext。",
        )
    if (
        request.release.position_model_bundle_id != request.quant.model_bundle_id
        or request.release.position_model_artifact_sha256
        != request.quant.model_artifact_sha256
        or request.release.agent_protocol_version != request.agent.protocol_version
    ):
        return _unavailable(
            request,
            "JOINT_COMPONENT_BINDING_MISMATCH",
            decision_reason="模型或Agent协议与联合发布版本不一致。",
        )
    if not (
        request.quant.as_of <= request.as_of < request.quant.valid_until
        and request.agent.as_of <= request.as_of < request.agent.valid_until
        and all(signal.available_at <= request.as_of for signal in request.agent.signals)
    ):
        return _unavailable(
            request,
            "JOINT_INPUT_NOT_CAUSAL_OR_EXPIRED",
            decision_reason="模型、Agent或证据在当前决策时点不可用。",
        )
    feasible = [
        value for value in request.quant.values if _is_feasible(value, request)
    ]
    selected = max(
        feasible,
        key=lambda value: (
            value.expected_delta_return_vs_hold,
            -ACTION_ORDER.index(value.action),
        ),
    )
    if selected.action == "ADD" and (
        request.agent.thesis_status != "SUPPORTED"
        or request.agent.counter_claims
    ):
        return _unavailable(
            request,
            "AGENT_QUANT_CONFLICT_REQUIRES_REVIEW",
            decision_reason="量化偏向加仓，但Agent论点或反证不支持扩大风险。",
        )
    if selected.action == "HOLD" and request.agent.thesis_status == "INVALIDATED":
        return _unavailable(
            request,
            "INVALIDATED_THESIS_REQUIRES_REVIEW",
            decision_reason="量化偏向持有，但原持仓论点已失效，必须优先复核。",
        )
    current = request.constraints.current_quantity_shares
    evidence_ids = list(
        dict.fromkeys(signal.evidence_id for signal in request.agent.signals)
    )
    valid_until = min(
        request.valid_until,
        request.quant.valid_until,
        request.agent.valid_until,
    )
    return PositionDecision(
        **{**_base(request), "valid_until": valid_until},
        assessment_ids=[request.agent.assessment_id],
        status="READY",
        action=selected.action,
        reason_codes=[
            "JOINT_EVALUATION_COMPLETE",
            f"QUANT_ACTION_{selected.action}",
            f"AGENT_THESIS_{request.agent.thesis_status}",
        ],
        evidence_ids=evidence_ids,
        current_quantity_shares=current,
        target_quantity_shares=selected.target_quantity_shares,
        delta_quantity_shares=selected.target_quantity_shares - current,
        expected_delta_return_vs_hold=selected.expected_delta_return_vs_hold,
        q10_delta_return_vs_hold=selected.q10_delta_return_vs_hold,
        q50_delta_return_vs_hold=selected.q50_delta_return_vs_hold,
        q90_delta_return_vs_hold=selected.q90_delta_return_vs_hold,
        stop_hazard=selected.stop_hazard,
        support=selected.support,
        quant_trend=request.quant.trend,
        agent_thesis_status=request.agent.thesis_status,
        agent_uncertainties=request.agent.uncertainties,
        counter_evidence_ids=list(
            dict.fromkeys(
                evidence_id
                for claim in request.agent.counter_claims
                for evidence_id in claim.evidence_ids
            )
        ),
        execution_path=selected.execution_path,
        price_lower=selected.price_lower,
        price_upper=selected.price_upper,
        price_basis=selected.price_basis,
        trigger_conditions=selected.trigger_conditions,
        estimated_costs=selected.estimated_costs,
        model_prediction_ref=(
            f"{request.quant.model_bundle_id}:"
            f"{request.quant.model_artifact_sha256}"
        ),
        agent_contribution_ref=request.agent.assessment_id,
        decision_reason=(
            "在同一决策时点内完成量化动作价值、Agent论点状态与账户约束仲裁。"
        ),
        review_after=min(request.agent.review_after, valid_until),
    )
