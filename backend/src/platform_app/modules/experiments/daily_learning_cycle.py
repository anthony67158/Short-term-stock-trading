"""Resumable daily learning workflow with fail-closed shadow promotion."""

import json
import os
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from sqlalchemy import select

from platform_app.adapters.database import sessions
from platform_app.modules.experiments import release_service
from platform_app.modules.experiments.contracts import (
    ExperimentInput,
    FreezeStrategyInput,
    ReleaseActivationInput,
    ReleaseCandidateInput,
)
from platform_app.modules.experiments.daily_joint_cycle import (
    write_daily_joint_cycle,
)
from platform_app.modules.experiments.market_dataset_audit import (
    audit_market_dataset,
)
from platform_app.modules.experiments.models import (
    Experiment,
    ReleaseRecord,
    StrategyVersion,
)
from platform_app.modules.experiments.outcome_settlement import (
    settle_prospective_outcomes,
)
from platform_app.modules.experiments.service import (
    create_experiment,
    freeze_strategy_version,
)
from platform_app.modules.operations.models import Job
from platform_app.modules.review.contracts import (
    ReviewRunInput,
    StrategyCompilationInput,
)
from platform_app.modules.review.models import (
    ImprovementProposal,
    ReviewReport,
)
from platform_app.modules.review.service import (
    ReviewError,
    submit_review,
    submit_strategy_compilation,
)

DAILY_LEARNING_SCHEMA_VERSION = "daily-learning-cycle.v1"


class DailyLearningError(ValueError):
    pass


def _decimal(value: object) -> Decimal | None:
    if not isinstance(value, str):
        return None
    try:
        result = Decimal(value)
    except InvalidOperation:
        return None
    return result if result.is_finite() else None


def _improvement_decision(
    candidate: Experiment,
    active: Experiment | None,
) -> tuple[bool, list[str]]:
    result = candidate.result
    if candidate.status != "SUCCEEDED" or result.get(
        "evaluation_status",
        result.get("evaluationStatus"),
    ) != "VALID":
        return False, ["EXPERIMENT_NOT_VALID"]
    variants = result.get("variants", {})

    def metric(variant: str, key: str) -> Decimal | None:
        row = variants.get(variant, {})
        snake = {
            "meanNetReturn": "mean_net_return",
            "meanDeltaVsFormula": "mean_delta_vs_formula",
            "confidence95Lower": "confidence95_lower",
        }[key]
        return _decimal(row.get(key, row.get(snake)))

    joint = metric("JOINT", "meanNetReturn")
    no_agent = metric("NO_AGENT", "meanNetReturn")
    delta_formula = metric("JOINT", "meanDeltaVsFormula")
    lower = metric("JOINT", "confidence95Lower")
    if None in (joint, no_agent, delta_formula, lower):
        return False, ["EXPERIMENT_METRICS_INCOMPLETE"]
    blockers = []
    if joint <= no_agent:
        blockers.append("JOINT_NOT_BETTER_THAN_NO_AGENT")
    if delta_formula <= 0:
        blockers.append("JOINT_NOT_BETTER_THAN_FORMULA")
    if lower <= 0:
        blockers.append("JOINT_CONFIDENCE_LOWER_NOT_POSITIVE")
    if active and active.status == "SUCCEEDED":
        active_joint = _decimal(
            active.result.get("variants", {})
            .get("JOINT", {})
            .get(
                "meanNetReturn",
                active.result.get("variants", {})
                .get("JOINT", {})
                .get("mean_net_return"),
            )
        )
        if active_joint is not None and joint <= active_joint:
            blockers.append("JOINT_NOT_BETTER_THAN_ACTIVE_RELEASE")
    return not blockers, blockers


def _job_state(job: Job) -> dict:
    return {
        "jobId": job.id,
        "jobStatus": job.status,
        "errorCode": job.error_code,
    }


def _active_release_record() -> ReleaseRecord | None:
    with sessions()() as db:
        return db.scalar(
            select(ReleaseRecord).where(
                ReleaseRecord.status == "ACTIVE",
            )
        )


def _advance_learning(
    *,
    owner_id: str,
    review_date: date,
    active_release_id: str,
) -> dict:
    review_key = f"daily-review:{review_date.isoformat()}"
    with sessions()() as db:
        report = db.scalar(
            select(ReviewReport).where(
                ReviewReport.owner_id == owner_id,
                ReviewReport.review_date == review_date,
            )
        )
        review_job = db.scalar(
            select(Job).where(
                Job.owner_id == owner_id,
                Job.kind == "DAILY_REVIEW",
                Job.business_key == review_key,
            )
        )
    if report is None:
        if review_job is not None:
            return {
                "stage": "REVIEW",
                "decision": (
                    "BLOCKED"
                    if review_job.status in {"FAILED", "CANCELLED", "EXPIRED"}
                    else "WAIT"
                ),
                **_job_state(review_job),
            }
        try:
            job = submit_review(
                owner_id,
                ReviewRunInput(review_date=review_date),
                review_key,
            )
        except ReviewError as exc:
            return {
                "stage": "REVIEW",
                "decision": "BLOCKED",
                "errorCode": exc.code,
            }
        return {
            "stage": "REVIEW",
            "decision": "SUBMITTED",
            **_job_state(job),
        }

    with sessions()() as db:
        proposal = db.scalar(
            select(ImprovementProposal)
            .where(
                ImprovementProposal.review_report_id == report.id,
                ImprovementProposal.status.in_(["DRAFT", "COMPILED"]),
            )
            .order_by(
                ImprovementProposal.created_at,
                ImprovementProposal.id,
            )
            .limit(1)
        )
    if proposal is None:
        return {
            "stage": "PROPOSAL",
            "decision": "KEEP_CURRENT_RELEASE",
            "reasonCodes": ["NO_ACTIONABLE_IMPROVEMENT_PROPOSAL"],
        }
    compilation_key = f"daily-strategy-proposal:{proposal.id}"
    with sessions()() as db:
        compilation_job = db.scalar(
            select(Job).where(
                Job.owner_id == owner_id,
                Job.kind == "STRATEGY_PROPOSAL",
                Job.business_key == compilation_key,
            )
        )
    if proposal.status == "DRAFT":
        if compilation_job is not None:
            return {
                "stage": "STRATEGY_PROPOSAL",
                "decision": (
                    "BLOCKED"
                    if compilation_job.status
                    in {"FAILED", "CANCELLED", "EXPIRED"}
                    else "WAIT"
                ),
                **_job_state(compilation_job),
            }
        try:
            job = submit_strategy_compilation(
                owner_id,
                proposal.id,
                StrategyCompilationInput(),
                compilation_key,
            )
        except ReviewError as exc:
            return {
                "stage": "STRATEGY_PROPOSAL",
                "decision": "BLOCKED",
                "errorCode": exc.code,
            }
        return {
            "stage": "STRATEGY_PROPOSAL",
            "decision": "SUBMITTED",
            **_job_state(job),
        }

    with sessions()() as db:
        strategy = db.get(
            StrategyVersion,
            proposal.compiled_strategy_version_id,
        )
        experiment = (
            db.scalar(
                select(Experiment).where(
                    Experiment.strategy_version_id == strategy.id,
                )
            )
            if strategy
            else None
        )
    if strategy is None:
        return {
            "stage": "EXPERIMENT",
            "decision": "BLOCKED",
            "errorCode": "COMPILED_STRATEGY_MISSING",
        }
    if strategy.status == "DRAFT":
        strategy = freeze_strategy_version(
            owner_id,
            strategy.id,
            FreezeStrategyInput(expected_revision=strategy.revision),
        )
    if strategy.status == "FROZEN":
        experiment = create_experiment(
            owner_id,
            ExperimentInput(strategy_version_id=strategy.id),
            f"daily-experiment:{strategy.id}",
        )
    if experiment is None:
        with sessions()() as db:
            experiment = db.scalar(
                select(Experiment).where(
                    Experiment.strategy_version_id == strategy.id,
                )
            )
    if experiment is None:
        return {
            "stage": "EXPERIMENT",
            "decision": "BLOCKED",
            "errorCode": "EXPERIMENT_RESULT_MISSING",
        }
    with sessions()() as db:
        active_record = db.scalar(
            select(ReleaseRecord).where(
                ReleaseRecord.status == "ACTIVE",
            )
        )
        active_experiment = (
            db.get(Experiment, active_record.experiment_id)
            if active_record
            else None
        )
    if active_record and active_record.experiment_id == experiment.id:
        return {
            "stage": "RELEASE",
            "decision": "ALREADY_ACTIVE",
            "releaseId": active_record.bundle_id,
        }
    improved, blockers = _improvement_decision(
        experiment,
        active_experiment,
    )
    if not improved:
        return {
            "stage": "COMPARISON",
            "decision": "KEEP_CURRENT_RELEASE",
            "experimentId": experiment.id,
            "reasonCodes": blockers,
        }
    candidate_id = (
        f"joint-auto-{review_date.strftime('%Y%m%d')}-"
        f"{experiment.id[:8]}"
    )
    try:
        candidate = release_service.register_release_candidate(
            owner_id,
            ReleaseCandidateInput(
                candidate_id=candidate_id,
                strategy_version_id=strategy.id,
                experiment_id=experiment.id,
                reason="每日联合评估通过受限改善门禁。",
            ),
            f"daily-release-candidate:{experiment.id}",
        )
        release = release_service.activate_release(
            owner_id,
            ReleaseActivationInput(
                candidate_id=candidate.bundle_id,
                expected_active_release_id=active_release_id,
                reason="每日联合评估确认改善，自动切换影子版本。",
            ),
            f"daily-release-activate:{experiment.id}",
        )
    except release_service.ReleaseError as exc:
        return {
            "stage": "RELEASE",
            "decision": "BLOCKED",
            "errorCode": exc.code,
        }
    return {
        "stage": "RELEASE",
        "decision": "PUBLISHED_SHADOW",
        "experimentId": experiment.id,
        "releaseId": release.bundle_id,
        "allowsNewRisk": release.allows_new_risk,
    }


def run_daily_learning_cycle(
    *,
    output_root: Path,
    active_release_pointer: Path,
    market_dataset_root: Path,
    account_backtest_path: Path,
    minimum_matured_samples: int = 2000,
    as_of: datetime | None = None,
) -> dict:
    now = as_of or datetime.now(UTC)
    if now.tzinfo is None:
        raise DailyLearningError("DAILY_LEARNING_AS_OF_TZ_REQUIRED")
    quality = audit_market_dataset(
        market_dataset_root,
        observed_at=lambda: now.astimezone(UTC).isoformat(),
    )
    settlement = (
        settle_prospective_outcomes(
            market_dataset_root=market_dataset_root,
            as_of=now,
        )
        if quality["passed"]
        else {
            "schemaVersion": "outcome-settlement-run.v1",
            "status": "SKIPPED",
            "reason": "MARKET_DATASET_QUALITY_FAILED",
        }
    )
    evidence = write_daily_joint_cycle(
        output_root=output_root,
        active_release_pointer=active_release_pointer,
        market_dataset_root=market_dataset_root,
        account_backtest_path=account_backtest_path,
        minimum_matured_samples=minimum_matured_samples,
        as_of=now,
    )
    if not quality["passed"]:
        learning = {
            "stage": "DATA_QUALITY",
            "decision": "BLOCKED",
            "errorCode": "MARKET_DATASET_QUALITY_FAILED",
        }
    else:
        active = _active_release_record()
        if active is None or active.bundle_id != evidence["activeRelease"][
            "releaseId"
        ]:
            learning = {
                "stage": "RELEASE",
                "decision": "BLOCKED",
                "errorCode": "ACTIVE_RELEASE_REGISTRY_MISMATCH",
            }
        else:
            learning = _advance_learning(
                owner_id=active.owner_id,
                review_date=date.fromisoformat(
                    f"{evidence['marketDataset']['endDate'][:4]}-"
                    f"{evidence['marketDataset']['endDate'][4:6]}-"
                    f"{evidence['marketDataset']['endDate'][6:]}"
                ),
                active_release_id=active.bundle_id,
            )
    report = {
        "schemaVersion": DAILY_LEARNING_SCHEMA_VERSION,
        "runId": now.strftime("learning-%Y%m%dT%H%M%SZ"),
        "createdAt": now.astimezone(UTC).isoformat(),
        "quality": {
            "passed": quality["passed"],
            "reportSha256": quality["reportSha256"],
            "violations": quality["violations"],
        },
        "settlement": settlement,
        "releaseEvidence": evidence,
        "learning": learning,
    }
    root = output_root.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"{report['runId']}.json"
    if target.exists():
        existing = json.loads(target.read_text())
        if existing != report:
            raise DailyLearningError("DAILY_LEARNING_RUN_ALREADY_EXISTS")
        return existing
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(
            report,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        )
        + "\n"
    )
    os.replace(temporary, target)
    return report
