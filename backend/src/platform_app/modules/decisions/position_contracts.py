"""Contracts for joint quant-Agent position decisions."""

from datetime import timedelta
from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, model_validator

from platform_app.contracts.base import (
    Contract,
    InstrumentId,
    Money,
    Price,
    Quantity,
)
from platform_app.modules.research.contracts import Claim

POSITION_DECISION_SCHEMA_VERSION = "position-decision.v1"
POSITION_AGENT_PROTOCOL_VERSION = "position-assessment.v1"
POSITION_VALUE_SCHEMA_VERSION = "position-action-reference.v1"

PositionAction = Literal["HOLD", "ADD", "REDUCE", "EXIT"]
ReturnValue = Annotated[float, Field(ge=-10, le=10)]
Probability = Annotated[float, Field(ge=0, le=1)]


class ActionValueEstimate(Contract):
    action: PositionAction
    target_quantity_shares: Quantity
    expected_delta_return_vs_hold: ReturnValue
    q10_delta_return_vs_hold: ReturnValue
    q50_delta_return_vs_hold: ReturnValue
    q90_delta_return_vs_hold: ReturnValue
    stop_hazard: Probability
    support: Probability
    execution_path: str | None = Field(default=None, min_length=1, max_length=160)
    price_lower: Price | None = None
    price_upper: Price | None = None
    price_basis: str | None = Field(default=None, min_length=1, max_length=160)
    trigger_conditions: list[str] = Field(default_factory=list, max_length=16)
    estimated_costs: Money

    @model_validator(mode="after")
    def ordered_quantiles(self):
        if not (
            self.q10_delta_return_vs_hold
            <= self.q50_delta_return_vs_hold
            <= self.q90_delta_return_vs_hold
        ):
            raise ValueError("动作价值分位数必须按Q10、Q50、Q90递增")
        execution = (
            self.execution_path,
            self.price_lower,
            self.price_upper,
            self.price_basis,
        )
        if self.action == "HOLD":
            if (
                any(value is not None for value in execution)
                or self.trigger_conditions
                or self.estimated_costs != 0
            ):
                raise ValueError("HOLD不得构造虚假执行条件或成本")
        elif (
            any(value is None for value in execution)
            or not self.trigger_conditions
            or self.price_lower > self.price_upper
        ):
            raise ValueError("交易动作必须包含完整且有序的执行条件")
        return self


class PositionValueReference(Contract):
    schema_version: Literal["position-action-reference.v1"] = POSITION_VALUE_SCHEMA_VERSION
    model_bundle_id: str = Field(min_length=1, max_length=160)
    model_artifact_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    feature_schema_version: str = Field(min_length=1, max_length=160)
    context_id: str = Field(min_length=1, max_length=160)
    account_id: str = Field(min_length=1, max_length=160)
    account_version: int = Field(strict=True, ge=1)
    instrument_id: InstrumentId
    as_of: AwareDatetime
    valid_until: AwareDatetime
    horizon: str = Field(min_length=1, max_length=160)
    trend: Literal["BULLISH", "NEUTRAL", "BEARISH", "UNCERTAIN"]
    current_quantity_shares: Quantity
    values: list[ActionValueEstimate] = Field(min_length=4, max_length=4)
    cost_assumptions_ref: str = Field(min_length=1, max_length=160)
    calibration_ref: str = Field(min_length=1, max_length=160)

    @model_validator(mode="after")
    def complete_action_vector(self):
        by_action = {value.action: value for value in self.values}
        if set(by_action) != {"HOLD", "ADD", "REDUCE", "EXIT"}:
            raise ValueError("动作价值必须恰好包含HOLD、ADD、REDUCE、EXIT")
        hold = by_action["HOLD"]
        if (
            hold.target_quantity_shares != self.current_quantity_shares
            or any(
                value != 0
                for value in (
                    hold.expected_delta_return_vs_hold,
                    hold.q10_delta_return_vs_hold,
                    hold.q50_delta_return_vs_hold,
                    hold.q90_delta_return_vs_hold,
                )
            )
        ):
            raise ValueError("HOLD必须保持当前数量并作为零增量基线")
        if by_action["ADD"].target_quantity_shares <= self.current_quantity_shares:
            raise ValueError("ADD目标数量必须增加")
        if not (
            0
            < by_action["REDUCE"].target_quantity_shares
            < self.current_quantity_shares
        ):
            raise ValueError("REDUCE目标数量必须介于零与当前数量之间")
        if by_action["EXIT"].target_quantity_shares != 0:
            raise ValueError("EXIT目标数量必须为零")
        if self.valid_until <= self.as_of:
            raise ValueError("动作价值有效期必须晚于评估时点")
        return self


class PositionEvidenceSignal(Contract):
    evidence_id: str = Field(min_length=1, max_length=160)
    category: Literal[
        "MAIN_FLOW",
        "ORDER_FLOW",
        "REALTIME_MARKET",
        "ANNOUNCEMENT",
        "NEWS",
        "INDUSTRY",
        "FINANCIAL",
    ]
    direction: Literal["POSITIVE", "NEUTRAL", "NEGATIVE", "MIXED"]
    statement: str = Field(min_length=1, max_length=1500)
    source_id: str = Field(min_length=1, max_length=300)
    provider: str = Field(min_length=1, max_length=160)
    methodology: str = Field(min_length=1, max_length=1000)
    published_at: AwareDatetime
    first_seen_at: AwareDatetime
    available_at: AwareDatetime
    validation: Literal["PRIMARY_VERIFIED", "CROSS_CHECKED", "VENDOR_DERIVED", "UNVERIFIED"]

    @model_validator(mode="after")
    def causal_times(self):
        if not self.published_at <= self.first_seen_at <= self.available_at:
            raise ValueError("证据时间必须满足publishedAt <= firstSeenAt <= availableAt")
        return self


class PositionAssessment(Contract):
    assessment_id: str = Field(min_length=1, max_length=160)
    protocol_version: Literal["position-assessment.v1"] = POSITION_AGENT_PROTOCOL_VERSION
    model_id: str = Field(min_length=1, max_length=160)
    source_snapshot_id: str = Field(min_length=1, max_length=160)
    context_id: str = Field(min_length=1, max_length=160)
    account_id: str = Field(min_length=1, max_length=160)
    account_version: int = Field(strict=True, ge=1)
    instrument_id: InstrumentId
    as_of: AwareDatetime
    valid_until: AwareDatetime
    thesis_status: Literal["SUPPORTED", "WEAKENED", "INVALIDATED", "UNCERTAIN"]
    claims: list[Claim] = Field(min_length=1, max_length=16)
    counter_claims: list[Claim] = Field(max_length=16)
    signals: list[PositionEvidenceSignal] = Field(min_length=1, max_length=32)
    uncertainties: list[str] = Field(max_length=16)
    invalidation_conditions: list[str] = Field(min_length=1, max_length=16)
    review_after: AwareDatetime
    status: Literal["VALIDATED"] = "VALIDATED"

    @model_validator(mode="after")
    def bounded_validity_and_references(self):
        if not self.as_of < self.valid_until <= self.as_of + timedelta(hours=24):
            raise ValueError("持仓研判有效期必须在评估时点后24小时内")
        if not self.as_of < self.review_after <= self.valid_until:
            raise ValueError("复核时间必须位于研判有效期内")
        if any(signal.available_at > self.as_of for signal in self.signals):
            raise ValueError("研判不得使用评估时点后才可用的证据")
        signal_ids = {signal.evidence_id for signal in self.signals}
        referenced = {
            evidence_id
            for claim in (*self.claims, *self.counter_claims)
            for evidence_id in claim.evidence_ids
        }
        if not referenced <= signal_ids:
            raise ValueError("研判只能引用当前来源快照内的证据")
        signals = {signal.evidence_id: signal for signal in self.signals}
        for claim in (*self.claims, *self.counter_claims):
            if claim.kind == "OBSERVED" and not any(
                claim.statement == signals[evidence_id].statement
                for evidence_id in claim.evidence_ids
            ):
                raise ValueError("OBSERVED必须逐字引用来源信号")
        return self


class JointReleaseReference(Contract):
    release_id: str = Field(min_length=1, max_length=160)
    status: Literal["READY", "UNAVAILABLE"]
    position_model_bundle_id: str | None = Field(default=None, min_length=1, max_length=160)
    position_model_artifact_sha256: str | None = Field(
        default=None,
        pattern=r"^[0-9a-f]{64}$",
    )
    agent_protocol_version: str | None = Field(default=None, min_length=1, max_length=160)
    blocker_codes: list[str] = Field(default_factory=list, max_length=32)

    @model_validator(mode="after")
    def ready_has_bound_components(self):
        if self.status == "READY" and (
            not self.position_model_bundle_id
            or not self.position_model_artifact_sha256
            or not self.agent_protocol_version
            or self.blocker_codes
        ):
            raise ValueError("READY联合版本必须绑定完整组件且没有阻断项")
        if self.status == "UNAVAILABLE" and not self.blocker_codes:
            raise ValueError("UNAVAILABLE联合版本必须说明阻断项")
        return self


class PositionConstraints(Contract):
    account_id: str = Field(min_length=1, max_length=160)
    account_version: int = Field(strict=True, ge=1)
    instrument_id: InstrumentId
    current_quantity_shares: Quantity
    sellable_quantity_shares: Quantity
    max_target_quantity_shares: Quantity
    lot_size_shares: int = Field(strict=True, ge=1, le=1_000_000)
    allowed_actions: set[PositionAction] = Field(min_length=1, max_length=4)
    quantity_rule_version: str = Field(min_length=1, max_length=160)
    fee_policy_version: str = Field(min_length=1, max_length=160)

    @model_validator(mode="after")
    def valid_limits(self):
        if self.sellable_quantity_shares > self.current_quantity_shares:
            raise ValueError("可卖数量不能超过当前持仓")
        if self.max_target_quantity_shares < self.current_quantity_shares:
            raise ValueError("最大目标数量不能低于当前持仓")
        if "HOLD" not in self.allowed_actions:
            raise ValueError("HOLD必须始终是合法候选动作")
        return self


class HardRiskState(Contract):
    policy_version: str = Field(min_length=1, max_length=160)
    source_snapshot_id: str = Field(min_length=1, max_length=160)
    as_of: AwareDatetime
    valid_until: AwareDatetime
    hard_stop_triggered: bool
    reason_codes: list[str] = Field(max_length=16)
    execution_path: str | None = Field(default=None, min_length=1, max_length=160)
    price_lower: Price | None = None
    price_upper: Price | None = None
    price_basis: str | None = Field(default=None, min_length=1, max_length=160)
    trigger_conditions: list[str] = Field(default_factory=list, max_length=16)
    estimated_costs: Money

    @model_validator(mode="after")
    def valid_risk_state(self):
        if self.valid_until <= self.as_of:
            raise ValueError("风险状态有效期必须晚于计算时点")
        if self.hard_stop_triggered and not self.reason_codes:
            raise ValueError("硬止损必须包含原因")
        execution = (
            self.execution_path,
            self.price_lower,
            self.price_upper,
            self.price_basis,
        )
        if self.hard_stop_triggered and (
            any(value is None for value in execution)
            or not self.trigger_conditions
            or self.price_lower > self.price_upper
        ):
            raise ValueError("硬止损必须包含可审计的执行条件")
        if not self.hard_stop_triggered and (
            any(value is not None for value in execution)
            or self.trigger_conditions
            or self.estimated_costs != 0
        ):
            raise ValueError("未触发硬止损时不得构造执行条件或成本")
        return self


class PositionDecisionRequest(Contract):
    decision_id: str = Field(min_length=1, max_length=160)
    context_id: str = Field(min_length=1, max_length=160)
    as_of: AwareDatetime
    valid_until: AwareDatetime
    release: JointReleaseReference
    constraints: PositionConstraints
    hard_risk: HardRiskState
    quant: PositionValueReference | None = None
    agent: PositionAssessment | None = None

    @model_validator(mode="after")
    def valid_decision_window(self):
        if self.valid_until <= self.as_of:
            raise ValueError("决策有效期必须晚于决策时点")
        return self


class PositionEvaluationInput(Contract):
    instrument_id: InstrumentId
    expected_version: int = Field(strict=True, ge=1)
    reason: str = Field(min_length=1, max_length=300, pattern=r"\S")


class PositionDecision(Contract):
    schema_version: Literal["position-decision.v1"] = POSITION_DECISION_SCHEMA_VERSION
    decision_id: str
    account_id: str
    instrument_id: InstrumentId
    context_id: str
    as_of: AwareDatetime
    valid_until: AwareDatetime
    account_version: int = Field(strict=True, ge=1)
    release_id: str
    assessment_ids: list[str]
    status: Literal["READY", "UNAVAILABLE"]
    action: Literal["HOLD", "ADD", "REDUCE", "EXIT", "NONE"]
    reason_codes: list[str] = Field(min_length=1)
    evidence_ids: list[str]
    current_quantity_shares: Quantity | None = None
    target_quantity_shares: Quantity | None = None
    delta_quantity_shares: int | None = Field(default=None, ge=-1_000_000_000, le=1_000_000_000)
    expected_delta_return_vs_hold: ReturnValue | None = None
    q10_delta_return_vs_hold: ReturnValue | None = None
    q50_delta_return_vs_hold: ReturnValue | None = None
    q90_delta_return_vs_hold: ReturnValue | None = None
    stop_hazard: Probability | None = None
    support: Probability | None = None
    quant_trend: Literal["BULLISH", "NEUTRAL", "BEARISH", "UNCERTAIN"] | None = None
    agent_thesis_status: Literal[
        "SUPPORTED", "WEAKENED", "INVALIDATED", "UNCERTAIN"
    ] | None = None
    agent_uncertainties: list[str] = Field(default_factory=list, max_length=16)
    counter_evidence_ids: list[str] = Field(default_factory=list, max_length=32)
    execution_path: str | None = None
    price_lower: Price | None = None
    price_upper: Price | None = None
    price_basis: str | None = None
    trigger_conditions: list[str] = Field(default_factory=list, max_length=16)
    estimated_costs: Money | None = None
    risk_policy_version: str
    quantity_rule_version: str
    fee_policy_version: str
    model_prediction_ref: str | None = None
    agent_contribution_ref: str | None = None
    decision_reason: str = Field(min_length=1, max_length=2000)
    review_after: AwareDatetime | None = None

    @model_validator(mode="after")
    def state_shape(self):
        quantities = (
            self.current_quantity_shares,
            self.target_quantity_shares,
            self.delta_quantity_shares,
        )
        if self.status == "UNAVAILABLE":
            if self.action != "NONE" or any(value is not None for value in quantities):
                raise ValueError("UNAVAILABLE只能输出NONE且不得伪造目标数量")
            return self
        if self.action == "NONE" or any(value is None for value in quantities):
            raise ValueError("READY必须输出明确动作和数量")
        if self.delta_quantity_shares != (
            self.target_quantity_shares - self.current_quantity_shares
        ):
            raise ValueError("数量增量与当前/目标数量不一致")
        expected_sign = {
            "HOLD": 0,
            "ADD": 1,
            "REDUCE": -1,
            "EXIT": -1,
        }[self.action]
        if expected_sign == 0 and self.delta_quantity_shares != 0:
            raise ValueError("HOLD不得改变数量")
        if expected_sign > 0 and self.delta_quantity_shares <= 0:
            raise ValueError("ADD必须增加数量")
        if expected_sign < 0 and self.delta_quantity_shares >= 0:
            raise ValueError("REDUCE/EXIT必须减少数量")
        if self.action == "EXIT" and self.target_quantity_shares != 0:
            raise ValueError("EXIT目标数量必须为零")
        if self.action in ("ADD", "REDUCE", "EXIT") and any(
            value is None
            for value in (
                self.execution_path,
                self.price_lower,
                self.price_upper,
                self.price_basis,
                self.estimated_costs,
            )
        ):
            raise ValueError("READY交易动作必须包含完整执行合同")
        return self


class PositionDecisionPage(Contract):
    decisions: list[PositionDecision]
    next_cursor: str | None
