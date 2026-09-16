"""Compile a validated Strategy Agent choice into one immutable draft."""

import hashlib
import json

from sqlalchemy import func, select

from platform_app.contracts.base import new_id
from platform_app.modules.experiments.contracts import StrategyVersionInput
from platform_app.modules.experiments.models import StrategyVersion
from platform_app.modules.operations.models import Outbox
from platform_app.modules.review.contracts import StrategyAgentOutput
from platform_app.modules.review.models import ImprovementProposal
from platform_app.modules.review.strategy_agent import validate_output


class StrategyCompilationError(ValueError):
    pass


def _fingerprint(value: StrategyVersionInput) -> str:
    return hashlib.sha256(
        json.dumps(
            value.model_dump(mode="json", exclude_none=True),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def compile_strategy_proposal(
    db,
    current_job,
    output: StrategyAgentOutput,
) -> dict:
    validate_output(
        output.model_dump_json(),
        current_job.payload,
    )
    proposal_id = current_job.payload["proposal"]["proposalId"]
    proposal = db.scalar(
        select(ImprovementProposal)
        .where(
            ImprovementProposal.id == proposal_id,
            ImprovementProposal.owner_id == current_job.owner_id,
        )
        .with_for_update()
    )
    if proposal is None or proposal.status != "DRAFT":
        raise StrategyCompilationError(
            "IMPROVEMENT_PROPOSAL_NOT_DRAFT"
        )
    if output.status == "REJECTED":
        proposal.status = "REJECTED"
        db.add(
            Outbox(
                owner_id=current_job.owner_id,
                event_type="strategy.proposal.rejected",
                aggregate_id=proposal.id,
                payload={
                    "schemaVersion": "strategy-proposal-result.v1",
                    "proposalId": proposal.id,
                    "reason": output.rationale,
                },
            )
        )
        return {
            "proposalId": proposal.id,
            "status": "REJECTED",
            "rationale": output.rationale,
        }
    base_id = current_job.payload["baseStrategy"]["id"]
    base = db.scalar(
        select(StrategyVersion).where(
            StrategyVersion.id == base_id,
            StrategyVersion.owner_id == current_job.owner_id,
            StrategyVersion.status.in_(["FROZEN", "EVALUATED"]),
        )
    )
    if base is None:
        raise StrategyCompilationError("BASE_STRATEGY_NOT_AVAILABLE")
    config = json.loads(json.dumps(base.config))
    parameters = config.setdefault("experimentParameters", {})
    if not isinstance(parameters, dict):
        raise StrategyCompilationError(
            "BASE_STRATEGY_EXPERIMENT_PARAMETERS_INVALID"
        )
    parameters[output.parameter_id] = output.candidate_value
    body = StrategyVersionInput(
        strategy_key=base.strategy_key,
        name=(f"{base.name} · {proposal.title}")[:120],
        hypothesis=proposal.hypothesis,
        scope=base.scope,
        config=config,
        dataset=base.dataset,
        split=base.split,
        release_policy=base.release_policy,
        fee_policy_version=base.fee_policy_version,
        risk_policy_version=base.risk_policy_version,
        simulation_policy_version=base.simulation_policy_version,
        confirmation_set_id=base.confirmation_set_id,
        minimum_effective_samples=base.minimum_effective_samples,
    )
    config_hash = _fingerprint(body)
    duplicate = db.scalar(
        select(StrategyVersion).where(
            StrategyVersion.owner_id == current_job.owner_id,
            StrategyVersion.strategy_key == base.strategy_key,
            StrategyVersion.config_hash == config_hash,
        )
    )
    if duplicate is not None:
        proposal.status = "REJECTED"
        return {
            "proposalId": proposal.id,
            "status": "REJECTED",
            "failureCode": "STRATEGY_CONFIG_EXISTS",
            "existingStrategyVersionId": duplicate.id,
        }
    version = int(
        db.scalar(
            select(
                func.coalesce(
                    func.max(StrategyVersion.version),
                    0,
                )
            ).where(
                StrategyVersion.owner_id == current_job.owner_id,
                StrategyVersion.strategy_key == base.strategy_key,
            )
        )
    ) + 1
    strategy = StrategyVersion(
        id=new_id(),
        owner_id=current_job.owner_id,
        version=version,
        status="DRAFT",
        config_hash=config_hash,
        request_key=f"strategy-proposal:{proposal.id}",
        request_hash=config_hash,
        revision=1,
        **body.model_dump(mode="json"),
    )
    db.add(strategy)
    db.flush()
    proposal.status = "COMPILED"
    proposal.compiled_strategy_version_id = strategy.id
    db.add(
        Outbox(
            owner_id=current_job.owner_id,
            event_type="strategy.proposal.compiled",
            aggregate_id=proposal.id,
            payload={
                "schemaVersion": "strategy-proposal-result.v1",
                "proposalId": proposal.id,
                "strategyVersionId": strategy.id,
                "parameterId": output.parameter_id,
                "candidateValue": output.candidate_value,
            },
        )
    )
    return {
        "proposalId": proposal.id,
        "status": "COMPILED",
        "strategyVersionId": strategy.id,
        "parameterId": output.parameter_id,
        "candidateValue": output.candidate_value,
        "rationale": output.rationale,
    }
