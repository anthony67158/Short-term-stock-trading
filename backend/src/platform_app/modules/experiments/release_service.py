import json
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select

from platform_app.adapters.database import sessions
from platform_app.config import settings
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.experiments.contracts import (
    AblationResult,
    ReleaseActivationInput,
    ReleaseCandidateInput,
    ReleasePage,
    ReleaseRollbackInput,
    ReleaseView,
)
from platform_app.modules.experiments.joint_bundle import (
    JointBundleError,
    _active_pointer,
    _file_sha256,
    activate_existing_shadow_release,
    publish_shadow_release,
    write_joint_candidate,
)
from platform_app.modules.experiments.models import (
    Experiment,
    ReleaseRecord,
    StrategyVersion,
)
from platform_app.modules.experiments.service import _fingerprint
from platform_app.modules.identity.models import User
from platform_app.modules.operations.models import Outbox


class ReleaseError(ValueError):
    def __init__(self, code: str, message: str, status: int = 409):
        self.code, self.message, self.status = code, message, status


def _view(row: ReleaseRecord) -> ReleaseView:
    return ReleaseView.model_validate(row)


def _publisher_id(db) -> str | None:
    active_owner = db.scalar(
        select(ReleaseRecord.owner_id).where(ReleaseRecord.status == "ACTIVE").limit(1)
    )
    if active_owner:
        return active_owner
    return db.scalar(select(User.id).order_by(User.created_at, User.id).limit(1))


def _authorize_publisher(db, owner_id: str) -> None:
    if _publisher_id(db) != owner_id:
        raise ReleaseError(
            "RELEASE_PERMISSION_DENIED",
            "当前用户没有联合包发布权限",
            403,
        )


def _owned_experiment(db, owner_id: str, strategy_id: str, experiment_id: str):
    strategy = db.scalar(
        select(StrategyVersion).where(
            StrategyVersion.id == strategy_id,
            StrategyVersion.owner_id == owner_id,
        )
    )
    experiment = db.scalar(
        select(Experiment).where(
            Experiment.id == experiment_id,
            Experiment.owner_id == owner_id,
            Experiment.strategy_version_id == strategy_id,
        )
    )
    if not strategy or not experiment:
        raise ReleaseError(
            "RELEASE_EVIDENCE_NOT_FOUND",
            "策略版本或实验不存在，不能创建发布候选",
            404,
        )
    if strategy.status != "EVALUATED":
        raise ReleaseError(
            "RELEASE_STRATEGY_NOT_EVALUATED",
            "策略版本尚未完成冻结评估",
        )
    return strategy, experiment


def _write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")


def register_release_candidate(
    owner_id: str,
    body: ReleaseCandidateInput,
    key: str,
) -> ReleaseView:
    request_hash = _fingerprint(body)
    config = settings()
    candidate_root = config.joint_candidate_registry_root.expanduser().resolve() / body.candidate_id
    with sessions().begin() as db:
        _authorize_publisher(db, owner_id)
        existing = db.scalar(
            select(ReleaseRecord).where(
                ReleaseRecord.owner_id == owner_id,
                ReleaseRecord.request_key == key,
            )
        )
        if existing:
            if existing.request_hash != request_hash:
                raise ReleaseError(
                    "IDEMPOTENCY_CONFLICT",
                    "同一请求编号对应不同发布候选",
                )
            return _view(existing)
        strategy, experiment = _owned_experiment(
            db,
            owner_id,
            body.strategy_version_id,
            body.experiment_id,
        )
        if candidate_root.exists():
            raise ReleaseError(
                "RELEASE_CANDIDATE_EXISTS",
                "候选联合包已经存在且不可覆盖",
            )
        candidate_root.parent.mkdir(parents=True, exist_ok=True)
        try:
            with tempfile.TemporaryDirectory(
                prefix=".joint-candidate-",
                dir=candidate_root.parent,
            ) as temporary:
                temporary_root = Path(temporary)
                strategy_path = temporary_root / "strategy.json"
                ablation_path = temporary_root / "ablation.json"
                _write_json(
                    strategy_path,
                    {
                        "schemaVersion": "strategy-freeze.v1",
                        "strategyVersionId": strategy.id,
                        "status": strategy.status,
                        "configHash": strategy.config_hash,
                        "snapshot": {
                            "strategyKey": strategy.strategy_key,
                            "version": strategy.version,
                            "hypothesis": strategy.hypothesis,
                            "scope": strategy.scope,
                            "config": strategy.config,
                            "dataset": strategy.dataset,
                            "split": strategy.split,
                            "releasePolicy": strategy.release_policy,
                            "feePolicyVersion": strategy.fee_policy_version,
                            "riskPolicyVersion": strategy.risk_policy_version,
                            "simulationPolicyVersion": (strategy.simulation_policy_version),
                            "confirmationSetId": (strategy.confirmation_set_id),
                        },
                    },
                )
                _write_json(
                    ablation_path,
                    {
                        **AblationResult.model_validate(experiment.result).model_dump(
                            mode="json", by_alias=True
                        ),
                        "schemaVersion": "four-way-ablation.v1",
                        "experimentId": experiment.id,
                        "strategyVersionId": strategy.id,
                        "configHash": strategy.config_hash,
                    },
                )
                manifest = write_joint_candidate(
                    output_root=candidate_root,
                    bundle_id=body.candidate_id,
                    ranking_model_root=config.ranking_model_root,
                    quant_model_root=config.quant_model_root,
                    position_model_root=config.position_model_root,
                    account_backtest_path=config.account_backtest_path,
                    strategy_artifact_path=strategy_path,
                    ablation_artifact_path=ablation_path,
                    agent_model=config.agent_model,
                )
        except JointBundleError as exc:
            raise ReleaseError(
                str(exc),
                "联合包组件或实验血缘校验失败",
                422,
            ) from exc
        manifest_path = candidate_root / "manifest.json"
        row = ReleaseRecord(
            owner_id=owner_id,
            bundle_id=body.candidate_id,
            operation="CANDIDATE",
            status="APPROVED",
            deployment_mode=body.deployment_mode,
            manifest_path=str(manifest_path),
            manifest_sha256=_file_sha256(manifest_path),
            source_candidate_bundle_id=None,
            previous_bundle_id=None,
            rollback_target_bundle_id=None,
            strategy_version_id=strategy.id,
            experiment_id=experiment.id,
            reason=body.reason,
            blocker_codes=manifest["releaseBlockers"],
            allows_new_risk=False,
            request_key=key,
            request_hash=request_hash,
        )
        db.add(row)
        db.flush()
        return _view(row)


def _active_record(db):
    return db.scalar(
        select(ReleaseRecord).where(ReleaseRecord.status == "ACTIVE").with_for_update()
    )


def activate_release(
    owner_id: str,
    body: ReleaseActivationInput,
    key: str,
) -> ReleaseView:
    request_hash = _fingerprint(body)
    config = settings()
    with sessions().begin() as db:
        _authorize_publisher(db, owner_id)
        existing = db.scalar(
            select(ReleaseRecord).where(
                ReleaseRecord.owner_id == owner_id,
                ReleaseRecord.request_key == key,
            )
        )
        if existing:
            if existing.request_hash != request_hash:
                raise ReleaseError(
                    "IDEMPOTENCY_CONFLICT",
                    "同一请求编号对应不同发布操作",
                )
            return _view(existing)
        candidate = db.scalar(
            select(ReleaseRecord).where(
                ReleaseRecord.owner_id == owner_id,
                ReleaseRecord.bundle_id == body.candidate_id,
                ReleaseRecord.operation == "CANDIDATE",
                ReleaseRecord.status == "APPROVED",
            )
        )
        if not candidate:
            raise ReleaseError(
                "RELEASE_CANDIDATE_NOT_APPROVED",
                "发布候选不存在或未通过完整性校验",
                404,
            )
        active = _active_record(db)
        if active and active.bundle_id != body.expected_active_release_id:
            raise ReleaseError(
                "ACTIVE_RELEASE_CONFLICT",
                "活动联合版本已变化，请刷新后重试",
            )
        release_id = f"joint-shadow-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{new_id()[:8]}"
        try:
            result = publish_shadow_release(
                candidate_root=Path(candidate.manifest_path).parent,
                registry_root=config.joint_bundle_root.expanduser().resolve().parent,
                release_id=release_id,
                ranking_model_root=config.ranking_model_root,
                quant_model_root=config.quant_model_root,
                position_model_root=config.position_model_root,
                account_backtest_path=config.account_backtest_path,
                expected_active_release_id=body.expected_active_release_id,
            )
        except JointBundleError as exc:
            raise ReleaseError(
                str(exc),
                "活动版本已变化或联合包预加载失败",
                409,
            ) from exc
        now = utcnow()
        if active:
            active.status = "RETIRED"
        row = ReleaseRecord(
            owner_id=owner_id,
            bundle_id=release_id,
            operation="ACTIVATE",
            status="ACTIVE",
            deployment_mode="SHADOW",
            manifest_path=str(
                config.joint_bundle_root.expanduser().resolve().parent
                / result["pointer"]["manifest"]
            ),
            manifest_sha256=result["pointer"]["manifestSha256"],
            source_candidate_bundle_id=candidate.bundle_id,
            previous_bundle_id=body.expected_active_release_id,
            rollback_target_bundle_id=None,
            strategy_version_id=candidate.strategy_version_id,
            experiment_id=candidate.experiment_id,
            reason=body.reason,
            blocker_codes=result["release"]["releaseBlockers"],
            allows_new_risk=False,
            request_key=key,
            request_hash=request_hash,
            created_at=now,
            activated_at=now,
        )
        db.add(row)
        db.flush()
        db.add(
            Outbox(
                owner_id=owner_id,
                event_type="release.activated",
                aggregate_id=row.id,
                payload={
                    "schemaVersion": "1",
                    "releaseId": release_id,
                    "previousReleaseId": body.expected_active_release_id,
                    "deploymentMode": "SHADOW",
                },
            )
        )
        return _view(row)


def rollback_release(
    owner_id: str,
    target_release_id: str,
    body: ReleaseRollbackInput,
    key: str,
) -> ReleaseView:
    request_hash = _fingerprint(
        {
            "targetReleaseId": target_release_id,
            **body.model_dump(mode="json"),
        }
    )
    config = settings()
    with sessions().begin() as db:
        _authorize_publisher(db, owner_id)
        existing = db.scalar(
            select(ReleaseRecord).where(
                ReleaseRecord.owner_id == owner_id,
                ReleaseRecord.request_key == key,
            )
        )
        if existing:
            if existing.request_hash != request_hash:
                raise ReleaseError(
                    "IDEMPOTENCY_CONFLICT",
                    "同一请求编号对应不同回滚操作",
                )
            return _view(existing)
        target = db.scalar(
            select(ReleaseRecord)
            .where(
                ReleaseRecord.owner_id == owner_id,
                ReleaseRecord.bundle_id == target_release_id,
                ReleaseRecord.operation.in_(["ACTIVATE", "ROLLBACK"]),
            )
            .order_by(ReleaseRecord.created_at.desc())
        )
        if not target:
            raise ReleaseError(
                "ROLLBACK_TARGET_NOT_FOUND",
                "回滚目标不存在或不属于当前发布历史",
                404,
            )
        active = _active_record(db)
        if not active or active.bundle_id != body.expected_active_release_id:
            raise ReleaseError(
                "ACTIVE_RELEASE_CONFLICT",
                "活动联合版本已变化，请刷新后重试",
            )
        if target.bundle_id == active.bundle_id:
            raise ReleaseError(
                "ROLLBACK_TARGET_ACTIVE",
                "目标版本已经处于活动状态",
            )
        try:
            result = activate_existing_shadow_release(
                registry_root=config.joint_bundle_root.expanduser().resolve().parent,
                target_release_id=target.bundle_id,
                expected_active_release_id=body.expected_active_release_id,
            )
        except JointBundleError as exc:
            raise ReleaseError(
                str(exc),
                "回滚目标预加载失败或活动版本已变化",
                409,
            ) from exc
        now = utcnow()
        active.status = "RETIRED"
        row = ReleaseRecord(
            owner_id=owner_id,
            bundle_id=target.bundle_id,
            operation="ROLLBACK",
            status="ACTIVE",
            deployment_mode="SHADOW",
            manifest_path=target.manifest_path,
            manifest_sha256=result["pointer"]["manifestSha256"],
            source_candidate_bundle_id=target.source_candidate_bundle_id,
            previous_bundle_id=active.bundle_id,
            rollback_target_bundle_id=target.bundle_id,
            strategy_version_id=target.strategy_version_id,
            experiment_id=target.experiment_id,
            reason=body.reason,
            blocker_codes=result["release"]["releaseBlockers"],
            allows_new_risk=False,
            request_key=key,
            request_hash=request_hash,
            created_at=now,
            activated_at=now,
        )
        db.add(row)
        db.flush()
        db.add(
            Outbox(
                owner_id=owner_id,
                event_type="release.activated",
                aggregate_id=row.id,
                payload={
                    "schemaVersion": "1",
                    "releaseId": target.bundle_id,
                    "previousReleaseId": active.bundle_id,
                    "rollback": True,
                },
            )
        )
        return _view(row)


def releases(owner_id: str, limit: int) -> ReleasePage:
    config = settings()
    root = config.joint_bundle_root.expanduser().resolve().parent
    try:
        pointer = _active_pointer(root)
        active_release_id = pointer.get("releaseId") if pointer else None
    except JointBundleError:
        active_release_id = None
    with sessions()() as db:
        publisher_id = _publisher_id(db)
        rows = list(
            db.scalars(
                select(ReleaseRecord)
                .where(ReleaseRecord.owner_id == publisher_id)
                .order_by(
                    ReleaseRecord.created_at.desc(),
                    ReleaseRecord.id.desc(),
                )
                .limit(limit)
            )
        )
        return ReleasePage(
            active_release_id=active_release_id,
            can_manage=publisher_id == owner_id,
            releases=[_view(row) for row in rows],
        )
