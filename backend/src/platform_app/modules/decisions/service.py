import hashlib
import json
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from platform_app.adapters.database import sessions
from platform_app.config import settings
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.decisions.models import (
    CurrentDecision,
    DecisionContextRecord,
    DecisionRecord,
)
from platform_app.modules.decisions.position_contracts import (
    HardRiskState,
    JointReleaseReference,
    PositionConstraints,
    PositionDecision,
    PositionDecisionPage,
    PositionDecisionRequest,
    PositionEvaluationInput,
)
from platform_app.modules.decisions.position_engine import (
    arbitrate_position,
    unavailable_position,
)
from platform_app.modules.decisions.position_runtime import (
    build_position_assessment,
    build_position_value_reference,
    PositionRuntimeError,
    run_position_agent_assessment,
)
from platform_app.modules.experiments.joint_bundle import JointBundle, JointBundleError
from platform_app.modules.learning.models import ProspectiveSample
from platform_app.modules.operations import jobs
from platform_app.modules.operations.models import Job, Outbox
from platform_app.modules.portfolio.models import Account, PositionLot
from platform_app.modules.portfolio.models import ExecutionPlan
from platform_app.modules.portfolio.plan_contracts import (
    DecisionPlanInput,
    PlanInput,
    PlanView,
)
from platform_app.modules.portfolio import plans
from platform_app.modules.portfolio.service import owned_account
from platform_app.kernel.trading import trading_date
from platform_app.modules.research.agent import AgentFailure
from platform_app.modules.research.contracts import EvidenceView
from platform_app.modules.research.models import Evidence


class DecisionError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422):
        self.code, self.message, self.status = code, message, status


def _fingerprint(body) -> str:
    return hashlib.sha256(body.model_dump_json().encode()).hexdigest()


def active_release() -> JointReleaseReference:
    root = settings().joint_bundle_root
    if root is None or not root.expanduser().exists():
        return JointReleaseReference(
            release_id="no-active-joint-release",
            status="UNAVAILABLE",
            blocker_codes=["JOINT_RELEASE_NOT_CONFIGURED"],
        )
    try:
        return JointBundle(root, require_ready=False).position_release()
    except (JointBundleError, OSError, ValueError):
        return JointReleaseReference(
            release_id="invalid-joint-release",
            status="UNAVAILABLE",
            blocker_codes=["JOINT_RELEASE_INVALID"],
        )


def _position_agent_payload(
    db,
    owner_id: str,
    request: PositionDecisionRequest,
    reason: str,
) -> dict:
    rows = list(
        db.scalars(
            select(Evidence)
            .where(
                Evidence.owner_id == owner_id,
                Evidence.instrument_id
                == request.constraints.instrument_id,
                Evidence.available_at <= request.as_of,
            )
            .order_by(Evidence.available_at.desc(), Evidence.id)
            .limit(16)
        )
    )
    evidence = []
    for row in rows:
        candidate = EvidenceView.model_validate(row).model_dump(mode="json")
        if len(json.dumps([*evidence, candidate], ensure_ascii=False)) > 60000:
            break
        evidence.append(candidate)
    config = settings()
    return {
        "purpose": "POSITION",
        "request": {
            "instrument_id": request.constraints.instrument_id,
            "question": reason,
            "evidence_ids": [item["id"] for item in evidence],
        },
        "positionContext": {
            "currentQuantityShares": (
                request.constraints.current_quantity_shares
            ),
            "sellableQuantityShares": (
                request.constraints.sellable_quantity_shares
            ),
            "accountKind": request.constraints.account_kind,
            "reason": reason,
        },
        "evidence": evidence,
        "protocolVersion": "position-source-assessment.v1",
        "model": config.agent_model,
        "asOf": request.as_of.isoformat(),
        "deadline": (request.as_of + timedelta(minutes=3)).isoformat(),
    }


def submit_position_evaluation(
    owner_id: str,
    account_id: str,
    body: PositionEvaluationInput,
    key: str,
) -> Job:
    digest = _fingerprint(body)
    now = utcnow()
    with sessions().begin() as db:
        account = owned_account(db, owner_id, account_id, lock=True)
        existing = db.scalar(
            select(Job).where(
                Job.owner_id == owner_id,
                Job.kind == "POSITION_EVALUATION",
                Job.business_key == key,
            )
        )
        if existing:
            if existing.input_hash != digest:
                raise DecisionError(
                    "IDEMPOTENCY_CONFLICT",
                    "同一请求编号的内容发生变化",
                    409,
                )
            return existing
        if account.version != body.expected_version:
            raise DecisionError(
                "ACCOUNT_VERSION_CONFLICT",
                "账户已有变化，请刷新后重新评估",
                409,
            )
        rows = list(
            db.scalars(
                select(PositionLot).where(
                    PositionLot.account_id == account_id,
                    PositionLot.instrument_id == body.instrument_id,
                    PositionLot.remaining_quantity > 0,
                )
            )
        )
        if not rows:
            raise DecisionError(
                "POSITION_NOT_FOUND",
                "当前账户没有这只股票的持仓",
                404,
            )
        current = sum(row.remaining_quantity for row in rows)
        sellable = sum(
            row.remaining_quantity
            for row in rows
            if row.acquired_date < trading_date(now)
        )
        release = active_release()
        context_id = new_id()
        snapshot = {
            "accountId": account_id,
            "accountVersion": account.version,
            "instrumentId": body.instrument_id,
            "currentQuantityShares": current,
            "sellableQuantityShares": sellable,
            "reason": body.reason,
            "release": release.model_dump(mode="json"),
            "asOf": now.isoformat(),
        }
        context_hash = hashlib.sha256(
            json.dumps(
                snapshot,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        request = PositionDecisionRequest(
            decision_id=new_id(),
            context_id=context_id,
            as_of=now,
            valid_until=now + timedelta(minutes=10),
            release=release,
            constraints=PositionConstraints(
                account_id=account_id,
                account_kind=account.kind,
                account_version=account.version,
                instrument_id=body.instrument_id,
                current_quantity_shares=current,
                sellable_quantity_shares=sellable,
                max_target_quantity_shares=(
                    current + max(current, 100)
                    if release.status == "SHADOW" and account.kind == "SIMULATED"
                    else current
                ),
                lot_size_shares=100,
                allowed_actions={"HOLD", "ADD", "REDUCE", "EXIT"},
                quantity_rule_version="a-share-lot.v1",
                fee_policy_version="actual-account-fees.v1",
            ),
            hard_risk=HardRiskState(
                policy_version="account-risk.v1",
                source_snapshot_id=context_hash,
                as_of=now,
                valid_until=now + timedelta(minutes=1),
                hard_stop_triggered=False,
                reason_codes=[],
                estimated_costs="0",
            ),
        )
        position_agent = _position_agent_payload(
            db,
            owner_id,
            request,
            body.reason,
        )
        job = Job(
            owner_id=owner_id,
            kind="POSITION_EVALUATION",
            business_key=key,
            input_hash=digest,
            priority=50,
            payload={
                "request": request.model_dump(mode="json"),
                "contextHash": context_hash,
                "snapshot": snapshot,
                "positionAgent": position_agent,
                "deadline": (now + timedelta(minutes=3)).isoformat(),
            },
        )
        db.add(job)
        db.flush()
        return job


def _position_agent_features(assessment) -> dict:
    claims = [*assessment.claims, *assessment.counter_claims]
    return {
        "schemaVersion": "position-agent-features.v1",
        "thesisStatus": assessment.thesis_status,
        "claimCounts": {
            kind: sum(claim.kind == kind for claim in claims)
            for kind in ("OBSERVED", "INFERRED", "HYPOTHESIS")
        },
        "counterClaimCount": len(assessment.counter_claims),
        "uncertaintyCount": len(assessment.uncertainties),
        "signalCategories": sorted({signal.category for signal in assessment.signals}),
        "evidenceCount": len({signal.evidence_id for signal in assessment.signals}),
    }


def _publish(
    db,
    job: Job,
    decision: PositionDecision,
    request: PositionDecisionRequest,
) -> dict:
    account = db.scalar(
        select(Account).where(
            Account.id == request.constraints.account_id,
            Account.owner_id == job.owner_id,
        ).with_for_update()
    )
    if not account or account.version != request.constraints.account_version:
        raise DecisionError(
            "ACCOUNT_VERSION_CONFLICT",
            "账户在评估期间发生变化，本次结果未发布",
            409,
        )
    context = db.scalar(
        select(DecisionContextRecord).where(
            DecisionContextRecord.owner_id == job.owner_id,
            DecisionContextRecord.context_hash == job.payload["contextHash"],
        )
    )
    if context:
        existing = db.scalar(
            select(DecisionRecord).where(DecisionRecord.context_id == context.id)
        )
        return {"decisionId": existing.id}
    context = DecisionContextRecord(
        id=request.context_id,
        owner_id=job.owner_id,
        account_id=account.id,
        instrument_id=request.constraints.instrument_id,
        account_version=account.version,
        release_id=request.release.release_id,
        context_hash=job.payload["contextHash"],
        snapshot=job.payload["snapshot"],
        assessment_ids=decision.assessment_ids,
        as_of=request.as_of,
    )
    record = DecisionRecord(
        id=decision.decision_id,
        owner_id=job.owner_id,
        account_id=account.id,
        instrument_id=decision.instrument_id,
        context_id=context.id,
        schema_version=decision.schema_version,
        status=decision.status,
        action=decision.action,
        account_version=decision.account_version,
        release_id=decision.release_id,
        payload=decision.model_dump(mode="json"),
        as_of=decision.as_of,
        valid_until=decision.valid_until,
    )
    db.add_all((context, record))
    db.flush()
    from platform_app.modules.decisions.monitoring import (
        register_decision_monitor,
    )

    register_decision_monitor(db, job.owner_id, decision)
    if request.release.status == "SHADOW" and request.quant and request.agent:
        db.add(
            ProspectiveSample(
                owner_id=job.owner_id,
                account_id=account.id,
                instrument_id=decision.instrument_id,
                assessment_id=request.agent.assessment_id,
                source_key=decision.decision_id,
                request_hash=hashlib.sha256(
                    decision.model_dump_json().encode()
                ).hexdigest(),
                decision_context_hash=job.payload["contextHash"],
                schema_version="prospective-position-sample.v1",
                decision_as_of=request.as_of,
                horizon_end_date=request.quant.horizon_end_date,
                market_snapshot_ref=request.quant.market_snapshot_ref,
                ranking_bundle_id=request.release.ranking_model_bundle_id,
                quant_bundle_id=request.release.quant_model_bundle_id,
                agent_protocol_version=request.agent.protocol_version,
                agent_feature_schema_version="position-agent-features.v1",
                agent_features=_position_agent_features(request.agent),
                quant_prediction=request.quant.model_dump(mode="json"),
                scenario={
                    "decisionStatus": decision.status,
                    "selectedAction": decision.action,
                    "targetQuantityShares": decision.target_quantity_shares,
                },
                context=job.payload["snapshot"],
                status="PENDING",
            )
        )
    db.flush()
    db.execute(
        insert(CurrentDecision)
        .values(
            account_id=account.id,
            instrument_id=decision.instrument_id,
            decision_id=decision.decision_id,
            updated_at=utcnow(),
        )
        .on_conflict_do_update(
            index_elements=["account_id", "instrument_id"],
            set_={
                "decision_id": decision.decision_id,
                "updated_at": utcnow(),
            },
        )
    )
    db.add(
        Outbox(
            owner_id=job.owner_id,
            event_type="decision.updated",
            aggregate_id=decision.decision_id,
            payload={
                "schemaVersion": "1",
                "accountId": account.id,
                "instrumentId": decision.instrument_id,
                "decisionId": decision.decision_id,
                "status": decision.status,
                "action": decision.action,
            },
        )
    )
    return {"decisionId": decision.decision_id}


def _enrich_shadow_job(
    job: Job,
    request: PositionDecisionRequest,
) -> PositionDecisionRequest:
    config = settings()
    quant = build_position_value_reference(request, config)
    try:
        agent = build_position_assessment(
            job.owner_id,
            request,
            require_position_source=True,
        )
    except PositionRuntimeError:
        payload = job.payload.get("positionAgent")
        can_run = (
            config.agent_enabled
            and bool(config.agent_api_key.get_secret_value())
            and isinstance(payload, dict)
            and (
                bool(payload.get("evidence"))
                or (
                    config.search_enabled
                    and bool(config.search_api_key.get_secret_value())
                )
            )
        )
        if can_run:
            if not jobs.mark_external(job):
                raise PositionRuntimeError("POSITION_AGENT_JOB_FENCED")
            try:
                agent = run_position_agent_assessment(
                    job.owner_id,
                    job.id,
                    request,
                    payload,
                )
            except AgentFailure as exc:
                raise PositionRuntimeError(str(exc)) from exc
        else:
            agent = build_position_assessment(job.owner_id, request)
    return request.model_copy(
        update={
            "quant": quant,
            "agent": agent,
        }
    )


def process_one() -> bool:
    job = jobs.claim(["POSITION_EVALUATION"], lease_seconds=210)
    if not job:
        return False
    if active_release() != PositionDecisionRequest.model_validate(
        job.payload["request"]
    ).release:
        jobs.finish(job, error="JOINT_RELEASE_CHANGED")
        return True
    request = PositionDecisionRequest.model_validate(job.payload["request"])
    try:
        if request.release.status == "SHADOW":
            request = _enrich_shadow_job(job, request)
        decision = arbitrate_position(request)
    except PositionRuntimeError as exc:
        decision = unavailable_position(
            request,
            str(exc),
            "影子评估缺少可验证的量化特征、价格或有效Agent研判。",
        )
    try:
        jobs.finish(
            job,
            publish=lambda db, current: _publish(
                db,
                current,
                decision,
                request,
            ),
        )
    except DecisionError as exc:
        jobs.finish(job, error=exc.code)
    return True


def decision_by_id(owner_id: str, decision_id: str) -> PositionDecision:
    with sessions()() as db:
        row = db.scalar(
            select(DecisionRecord).where(
                DecisionRecord.id == decision_id,
                DecisionRecord.owner_id == owner_id,
            )
        )
        if not row:
            raise DecisionError(
                "DECISION_NOT_FOUND",
                "决策不存在或无权访问",
                404,
            )
        return PositionDecision.model_validate(row.payload)


def current_decisions(
    owner_id: str,
    account_id: str,
    cursor: str | None,
    limit: int,
) -> PositionDecisionPage:
    with sessions()() as db:
        owned_account(db, owner_id, account_id)
        query = (
            select(DecisionRecord)
            .join(
                CurrentDecision,
                CurrentDecision.decision_id == DecisionRecord.id,
            )
            .where(CurrentDecision.account_id == account_id)
        )
        if cursor:
            query = query.where(DecisionRecord.instrument_id > cursor)
        rows = list(
            db.scalars(
                query.order_by(DecisionRecord.instrument_id).limit(limit + 1)
            )
        )
        return PositionDecisionPage(
            decisions=[
                PositionDecision.model_validate(row.payload)
                for row in rows[:limit]
            ],
            next_cursor=(
                rows[limit - 1].instrument_id if len(rows) > limit else None
            ),
        )


def create_execution_plan(
    owner_id: str,
    decision_id: str,
    body: DecisionPlanInput,
    key: str,
) -> PlanView:
    with sessions().begin() as db:
        record = db.scalar(
            select(DecisionRecord).where(
                DecisionRecord.id == decision_id,
                DecisionRecord.owner_id == owner_id,
            )
        )
        if record is None:
            raise DecisionError(
                "DECISION_NOT_FOUND",
                "决策不存在或无权访问",
                404,
            )
        existing = db.scalar(
            select(ExecutionPlan).where(
                ExecutionPlan.decision_id == decision_id,
            )
        )
        if existing is not None:
            return plans.plan_view(existing)
        pointer = db.get(
            CurrentDecision,
            (record.account_id, record.instrument_id),
        )
        decision = PositionDecision.model_validate(record.payload)
        if pointer is None or pointer.decision_id != decision_id:
            raise DecisionError(
                "DECISION_SUPERSEDED",
                "该决策已被更新，请使用当前建议",
                409,
            )
        now = utcnow()
        if decision.status != "READY" or decision.valid_until <= now:
            raise DecisionError(
                "DECISION_NOT_EXECUTABLE",
                "该决策当前不可生成计划",
                409,
            )
        if decision.action == "HOLD":
            raise DecisionError(
                "DECISION_HAS_NO_TRADE",
                "保持持仓不需要生成执行计划",
                422,
            )
        if decision.account_version != body.expected_version:
            raise DecisionError(
                "ACCOUNT_VERSION_CONFLICT",
                "账户已有变化，请重新评估后再生成计划",
                409,
            )
        side = "BUY" if decision.action == "ADD" else "SELL"
        quantity = abs(decision.delta_quantity_shares or 0)
        price = (
            decision.price_upper
            if side == "BUY"
            else decision.price_lower
        )
        if quantity == 0 or price is None:
            raise DecisionError(
                "DECISION_EXECUTION_CONTRACT_INCOMPLETE",
                "决策缺少可执行数量或价格边界",
                422,
            )
        plan = PlanInput(
            instrument_id=decision.instrument_id,
            side=side,
            quantity_shares=quantity,
            limit_price=price,
            fee_budget=decision.estimated_costs or Decimal(0),
            expires_at=decision.valid_until,
            reason=(
                f"联合决策 {decision.decision_id}: {decision.decision_reason}"
            )[:300],
            expected_version=body.expected_version,
        )
        return plans.create_plan_in_session(
            db,
            owner_id,
            record.account_id,
            plan,
            key,
            source="SYSTEM_DECISION",
            decision_id=decision_id,
        )
