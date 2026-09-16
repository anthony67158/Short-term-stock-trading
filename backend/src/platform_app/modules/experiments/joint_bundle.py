"""Versioned Agent feature contract and fail-closed joint release bundle."""

import hashlib
import json
import os
import re
import shutil
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

import fcntl

from platform_app.modules.experiments.account_backtest import (
    ACCOUNT_BACKTEST_SCHEMA_VERSION,
)
from platform_app.modules.experiments.position_action_model import (
    PositionActionBundle,
)
from platform_app.modules.decisions.position_contracts import (
    JointReleaseReference,
    POSITION_AGENT_PROTOCOL_VERSION,
    PositionDecision,
    PositionDecisionRequest,
    StrategyExperimentParameters,
)
from platform_app.modules.decisions.position_engine import arbitrate_position
from platform_app.modules.experiments.quant_model_bundle import QuantModelBundle
from platform_app.modules.experiments.ranking_model_bundle import RankingModelBundle
from platform_app.modules.research.agent import (
    ASSESSMENT_TOOL,
    POSITION_SYSTEM,
    SEARCH_TOOL,
    SYSTEM,
)
from platform_app.modules.research.contracts import (
    ASSESSMENT_PROTOCOL_VERSION,
    AssessmentOutput,
)
from platform_app.modules.review.strategy_agent import (
    EXPERIMENT_PARAMETER_REGISTRY,
)

JOINT_SCHEMA_VERSION = "joint-bundle.v2"
AGENT_FEATURE_SCHEMA_VERSION = "agent-features.v1"
AGENT_FEATURE_NAMES = (
    "thesisSupported",
    "thesisWeakened",
    "thesisInvalidated",
    "thesisUncertain",
    "strategyTrend",
    "strategyValue",
    "strategyQuality",
    "strategyEvent",
    "strategyRecovery",
    "observedClaimCount",
    "inferredClaimCount",
    "hypothesisClaimCount",
    "counterClaimCount",
    "uncertaintyCount",
    "uniqueEvidenceCount",
)


class JointBundleError(ValueError):
    pass


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _manifest_path(root_or_pointer: Path) -> Path:
    path = root_or_pointer.expanduser().resolve()
    if path.is_dir():
        return path / "manifest.json"
    try:
        pointer = json.loads(path.read_text())
        relative = Path(pointer["manifest"])
        manifest_path = (path.parent / relative).resolve()
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise JointBundleError("JOINT_RELEASE_POINTER_INVALID") from exc
    if (
        relative.is_absolute()
        or path.parent not in manifest_path.parents
        or not manifest_path.is_file()
        or _file_sha256(manifest_path) != pointer.get("manifestSha256")
    ):
        raise JointBundleError("JOINT_RELEASE_POINTER_INVALID")
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, TypeError, json.JSONDecodeError) as exc:
        raise JointBundleError("JOINT_RELEASE_POINTER_INVALID") from exc
    if manifest.get("bundleId") != pointer.get("releaseId"):
        raise JointBundleError("JOINT_RELEASE_POINTER_INVALID")
    return manifest_path


def _atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    os.replace(temporary, path)


@contextmanager
def _registry_lock(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".release.lock").open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _active_pointer(root: Path) -> dict | None:
    pointer_path = root / "active-shadow.json"
    if not pointer_path.exists():
        return None
    _manifest_path(pointer_path)
    try:
        return json.loads(pointer_path.read_text())
    except (OSError, TypeError, json.JSONDecodeError) as exc:
        raise JointBundleError("JOINT_RELEASE_POINTER_INVALID") from exc


def _read_artifact(path: Path, error_code: str) -> dict:
    try:
        value = json.loads(path.expanduser().resolve().read_text())
    except (OSError, TypeError, json.JSONDecodeError) as exc:
        raise JointBundleError(error_code) from exc
    if not isinstance(value, dict):
        raise JointBundleError(error_code)
    return value


def _verified_component_path(
    manifest_path: Path,
    relative_value: object,
    expected_sha256: object,
) -> Path:
    if not isinstance(relative_value, str):
        raise JointBundleError("JOINT_BUNDLE_COMPONENT_INVALID")
    relative = Path(relative_value)
    component_path = (manifest_path.parent / relative).resolve()
    if (
        relative.is_absolute()
        or manifest_path.parent not in component_path.parents
        or not component_path.is_file()
        or _file_sha256(component_path) != expected_sha256
    ):
        raise JointBundleError("JOINT_BUNDLE_COMPONENT_INVALID")
    return component_path


def encode_agent_assessment(assessment: AssessmentOutput | dict) -> dict[str, float]:
    output = AssessmentOutput.model_validate(assessment)
    claims = [*output.claims, *output.counter_claims]
    kinds = {kind: 0 for kind in ("OBSERVED", "INFERRED", "HYPOTHESIS")}
    evidence_ids = set()
    for claim in claims:
        kinds[claim.kind] += 1
        evidence_ids.update(claim.evidence_ids)
    statuses = {
        "SUPPORTED": "thesisSupported",
        "WEAKENED": "thesisWeakened",
        "INVALIDATED": "thesisInvalidated",
        "UNCERTAIN": "thesisUncertain",
    }
    strategies = {
        "TREND": "strategyTrend",
        "VALUE": "strategyValue",
        "QUALITY": "strategyQuality",
        "EVENT": "strategyEvent",
        "RECOVERY": "strategyRecovery",
    }
    values = {name: 0.0 for name in AGENT_FEATURE_NAMES}
    values[statuses[output.thesis_status]] = 1.0
    for strategy in output.strategy_fit:
        values[strategies[strategy]] = 1.0
    values.update(
        {
            "observedClaimCount": float(kinds["OBSERVED"]),
            "inferredClaimCount": float(kinds["INFERRED"]),
            "hypothesisClaimCount": float(kinds["HYPOTHESIS"]),
            "counterClaimCount": float(len(output.counter_claims)),
            "uncertaintyCount": float(len(output.uncertainties)),
            "uniqueEvidenceCount": float(len(evidence_ids)),
        }
    )
    return values


def write_joint_candidate(
    *,
    output_root: Path,
    bundle_id: str,
    ranking_model_root: Path,
    quant_model_root: Path,
    position_model_root: Path,
    account_backtest_path: Path,
    strategy_artifact_path: Path,
    ablation_artifact_path: Path,
    agent_model: str,
) -> dict:
    root = output_root.resolve()
    manifest_path = root / "manifest.json"
    if manifest_path.exists():
        raise JointBundleError("JOINT_BUNDLE_ALREADY_EXISTS")
    ranking = RankingModelBundle(ranking_model_root, require_ready=False)
    quant = QuantModelBundle(quant_model_root, require_ready=False)
    position = PositionActionBundle(position_model_root, require_ready=False)
    account_backtest_path = account_backtest_path.resolve()
    try:
        account_report = json.loads(account_backtest_path.read_text())
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise JointBundleError("JOINT_ACCOUNT_REPORT_INVALID") from exc
    if (
        account_report.get("schemaVersion") != ACCOUNT_BACKTEST_SCHEMA_VERSION
        or account_report["lineage"]["rankingModelArtifactSha256"]
        != ranking.manifest["artifactSha256"]
        or account_report["lineage"]["quantModelArtifactSha256"] != quant.manifest["artifactSha256"]
        or position.manifest.get("rankingDatabaseSha256")
        != ranking.manifest.get("rankingDatabaseSha256")
    ):
        raise JointBundleError("JOINT_COMPONENT_LINEAGE_MISMATCH")
    strategy_artifact_path = strategy_artifact_path.expanduser().resolve()
    ablation_artifact_path = ablation_artifact_path.expanduser().resolve()
    strategy = _read_artifact(
        strategy_artifact_path,
        "JOINT_STRATEGY_ARTIFACT_INVALID",
    )
    ablation = _read_artifact(
        ablation_artifact_path,
        "JOINT_ABLATION_ARTIFACT_INVALID",
    )
    if (
        strategy.get("schemaVersion") != "strategy-freeze.v1"
        or strategy.get("status") != "EVALUATED"
        or not re.fullmatch(r"[0-9a-f]{64}", strategy.get("configHash", ""))
        or ablation.get("schemaVersion") != "four-way-ablation.v1"
        or ablation.get("strategyVersionId") != strategy.get("strategyVersionId")
        or ablation.get("configHash") != strategy.get("configHash")
        or ablation.get("evaluationStatus") not in {"VALID", "INSUFFICIENT"}
        or not isinstance(ablation.get("experimentId"), str)
    ):
        raise JointBundleError("JOINT_EXPERIMENT_LINEAGE_MISMATCH")
    tool_schema = json.dumps(
        [SEARCH_TOOL, ASSESSMENT_TOOL],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    blockers = list(
        dict.fromkeys(
            [
                *account_report["releaseBlockers"],
                *position.manifest["releaseBlockers"],
                "AGENT_QUALITY_EVALUATION_PENDING",
                *(
                    [
                        "PROSPECTIVE_AGENT_SAMPLE_SUPPORT_INSUFFICIENT",
                        "JOINT_ABLATION_INSUFFICIENT",
                    ]
                    if ablation["evaluationStatus"] == "INSUFFICIENT"
                    else []
                ),
            ]
        )
    )
    root.mkdir(parents=True, exist_ok=True)
    strategy_target = root / "strategy.json"
    ablation_target = root / "ablation.json"
    for source, target in (
        (strategy_artifact_path, strategy_target),
        (ablation_artifact_path, ablation_target),
    ):
        temporary = target.with_suffix(target.suffix + ".tmp")
        shutil.copyfile(source, temporary)
        os.replace(temporary, target)
    manifest = {
        "bundleId": bundle_id,
        "schemaVersion": JOINT_SCHEMA_VERSION,
        "createdAt": datetime.now(UTC).isoformat(),
        "releaseStatus": "UNAVAILABLE",
        "releaseBlockers": blockers,
        "decisionFallback": {
            "status": "UNAVAILABLE",
            "action": "NONE",
            "allowsNewRisk": False,
        },
        "components": {
            "rankingModelBundleId": ranking.manifest["bundleId"],
            "rankingModelArtifactSha256": ranking.manifest["artifactSha256"],
            "quantModelBundleId": quant.manifest["bundleId"],
            "quantModelArtifactSha256": quant.manifest["artifactSha256"],
            "positionModelBundleId": position.manifest["bundleId"],
            "positionModelArtifactSha256": position.manifest["artifactSha256"],
            "accountBacktestSha256": _file_sha256(account_backtest_path),
            "strategyVersionId": strategy["strategyVersionId"],
            "strategyConfigHash": strategy["configHash"],
            "strategyArtifact": strategy_target.name,
            "strategyArtifactSha256": _file_sha256(strategy_target),
            "ablationExperimentId": ablation["experimentId"],
            "ablationArtifact": ablation_target.name,
            "ablationArtifactSha256": _file_sha256(ablation_target),
        },
        "agent": {
            "model": agent_model,
            "protocolVersion": ASSESSMENT_PROTOCOL_VERSION,
            "positionProtocolVersion": POSITION_AGENT_PROTOCOL_VERSION,
            "featureSchemaVersion": AGENT_FEATURE_SCHEMA_VERSION,
            "featureNames": AGENT_FEATURE_NAMES,
            "promptSha256": _sha256_bytes(SYSTEM.encode()),
            "positionPromptSha256": _sha256_bytes(POSITION_SYSTEM.encode()),
            "toolSchemaSha256": _sha256_bytes(tool_schema),
        },
        "missingArtifacts": (
            ["trained-joint-model"] if ablation["evaluationStatus"] == "INSUFFICIENT" else []
        ),
    }
    _atomic_json(manifest_path, manifest)
    return manifest


class JointBundle:
    def __init__(self, root: Path, *, require_ready: bool = True):
        manifest_path = _manifest_path(root)
        if not manifest_path.is_file():
            raise JointBundleError("JOINT_BUNDLE_MANIFEST_MISSING")
        try:
            self.manifest = json.loads(manifest_path.read_text())
        except (json.JSONDecodeError, TypeError) as exc:
            raise JointBundleError("JOINT_BUNDLE_MANIFEST_INVALID") from exc
        if (
            self.manifest.get("schemaVersion") != JOINT_SCHEMA_VERSION
            or not re.fullmatch(
                r"[0-9a-f]{64}",
                self.manifest.get("agent", {}).get("promptSha256", ""),
            )
            or not re.fullmatch(
                r"[0-9a-f]{64}",
                self.manifest.get("agent", {}).get(
                    "positionPromptSha256",
                    "",
                ),
            )
            or tuple(self.manifest.get("agent", {}).get("featureNames", ())) != AGENT_FEATURE_NAMES
        ):
            raise JointBundleError("JOINT_BUNDLE_MANIFEST_INVALID")
        components = self.manifest.get("components", {})
        strategy_path = _verified_component_path(
            manifest_path,
            components.get("strategyArtifact"),
            components.get("strategyArtifactSha256"),
        )
        _verified_component_path(
            manifest_path,
            components.get("ablationArtifact"),
            components.get("ablationArtifactSha256"),
        )
        strategy = _read_artifact(
            strategy_path,
            "JOINT_STRATEGY_ARTIFACT_INVALID",
        )
        parameters = (
            strategy.get("snapshot", {})
            .get("config", {})
            .get("experimentParameters", {})
        )
        if (
            not isinstance(parameters, dict)
            or any(
                key not in EXPERIMENT_PARAMETER_REGISTRY
                or value
                not in EXPERIMENT_PARAMETER_REGISTRY[key][
                    "allowedValues"
                ]
                for key, value in parameters.items()
            )
        ):
            raise JointBundleError(
                "JOINT_STRATEGY_PARAMETERS_INVALID"
            )
        try:
            self.experiment_parameters = (
                StrategyExperimentParameters.model_validate(parameters)
            )
        except ValueError as exc:
            raise JointBundleError(
                "JOINT_STRATEGY_PARAMETERS_INVALID"
            ) from exc
        status = self.manifest.get("releaseStatus")
        if status not in {"READY", "SHADOW", "UNAVAILABLE"}:
            raise JointBundleError("JOINT_BUNDLE_MANIFEST_INVALID")
        if status == "READY" and (
            self.manifest.get("releaseBlockers")
            or self.manifest.get("missingArtifacts")
            or self.manifest.get("agent", {}).get("positionProtocolVersion")
            != POSITION_AGENT_PROTOCOL_VERSION
            or self.manifest.get("allowsNewRisk") is not True
        ):
            raise JointBundleError("JOINT_BUNDLE_MANIFEST_INVALID")
        if status == "SHADOW" and (
            self.manifest.get("deploymentMode") != "SHADOW"
            or self.manifest.get("allowsNewRisk") is not False
            or self.manifest.get("agent", {}).get("positionProtocolVersion")
            != POSITION_AGENT_PROTOCOL_VERSION
        ):
            raise JointBundleError("JOINT_BUNDLE_MANIFEST_INVALID")
        if require_ready and status != "READY":
            raise JointBundleError("JOINT_BUNDLE_NOT_RELEASED")

    def position_release(self) -> JointReleaseReference:
        components = self.manifest.get("components", {})
        return JointReleaseReference(
            release_id=self.manifest["bundleId"],
            status=self.manifest["releaseStatus"],
            allows_new_risk=self.manifest.get("allowsNewRisk", False),
            ranking_model_bundle_id=components.get("rankingModelBundleId"),
            ranking_model_artifact_sha256=components.get("rankingModelArtifactSha256"),
            quant_model_bundle_id=components.get("quantModelBundleId"),
            quant_model_artifact_sha256=components.get("quantModelArtifactSha256"),
            position_model_bundle_id=components.get("positionModelBundleId"),
            position_model_artifact_sha256=components.get("positionModelArtifactSha256"),
            agent_protocol_version=self.manifest.get("agent", {}).get("positionProtocolVersion"),
            experiment_parameters=self.experiment_parameters,
            blocker_codes=self.manifest.get("releaseBlockers", []),
        )

    def arbitrate_position(
        self,
        request: PositionDecisionRequest,
    ) -> PositionDecision:
        if request.release != self.position_release():
            raise JointBundleError("JOINT_RELEASE_REFERENCE_MISMATCH")
        return arbitrate_position(request)

    def unavailable_decision(self) -> dict:
        if self.manifest.get("releaseStatus") == "READY":
            raise JointBundleError("JOINT_BUNDLE_READY_REQUIRES_DECISION_ENGINE")
        return {
            "status": "UNAVAILABLE",
            "action": "NONE",
            "reasonCodes": self.manifest["releaseBlockers"],
            "releaseId": self.manifest["bundleId"],
        }


def publish_shadow_release(
    *,
    candidate_root: Path,
    registry_root: Path,
    release_id: str,
    ranking_model_root: Path,
    quant_model_root: Path,
    position_model_root: Path,
    account_backtest_path: Path,
    expected_active_release_id: str | None = None,
) -> dict:
    candidate_path = candidate_root.expanduser().resolve() / "manifest.json"
    candidate = JointBundle(candidate_root, require_ready=False).manifest
    ranking = RankingModelBundle(ranking_model_root, require_ready=False)
    quant = QuantModelBundle(quant_model_root, require_ready=False)
    position = PositionActionBundle(position_model_root, require_ready=False)
    components = candidate["components"]
    expected = {
        "rankingModelBundleId": ranking.manifest["bundleId"],
        "rankingModelArtifactSha256": ranking.manifest["artifactSha256"],
        "quantModelBundleId": quant.manifest["bundleId"],
        "quantModelArtifactSha256": quant.manifest["artifactSha256"],
        "positionModelBundleId": position.manifest["bundleId"],
        "positionModelArtifactSha256": position.manifest["artifactSha256"],
        "accountBacktestSha256": _file_sha256(account_backtest_path.resolve()),
        **{
            key: candidate["components"][key]
            for key in (
                "strategyVersionId",
                "strategyConfigHash",
                "strategyArtifact",
                "strategyArtifactSha256",
                "ablationExperimentId",
                "ablationArtifact",
                "ablationArtifactSha256",
            )
        },
    }
    if components != expected:
        raise JointBundleError("JOINT_SHADOW_COMPONENT_MISMATCH")
    artifact_sources = {}
    for name in ("strategyArtifact", "ablationArtifact"):
        relative = Path(components[name])
        source = (candidate_path.parent / relative).resolve()
        if (
            relative.is_absolute()
            or relative.parent != Path(".")
            or candidate_path.parent not in source.parents
            or _file_sha256(source) != components[f"{name}Sha256"]
        ):
            raise JointBundleError("JOINT_SHADOW_COMPONENT_MISMATCH")
        artifact_sources[name] = source
    root = registry_root.expanduser().resolve()
    release_root = root / "releases" / release_id
    manifest_path = release_root / "manifest.json"
    pointer_path = root / "active-shadow.json"
    release = {
        **candidate,
        "bundleId": release_id,
        "sourceCandidateBundleId": candidate["bundleId"],
        "sourceCandidateManifestSha256": _file_sha256(candidate_path),
        "releaseStatus": "SHADOW",
        "deploymentMode": "SHADOW",
        "allowsNewRisk": False,
        "activatedAt": datetime.now(UTC).isoformat(),
        "agent": {
            **candidate["agent"],
            "positionProtocolVersion": POSITION_AGENT_PROTOCOL_VERSION,
        },
    }
    with _registry_lock(root):
        active = _active_pointer(root)
        active_id = active.get("releaseId") if active else None
        if active_id != expected_active_release_id:
            raise JointBundleError("JOINT_ACTIVE_RELEASE_CONFLICT")
        if manifest_path.exists():
            raise JointBundleError("JOINT_SHADOW_RELEASE_ALREADY_EXISTS")
        release_root.mkdir(parents=True, exist_ok=False)
        for name, source in artifact_sources.items():
            shutil.copyfile(source, release_root / components[name])
        _atomic_json(manifest_path, release)
        JointBundle(release_root, require_ready=False)
        relative = manifest_path.relative_to(root)
        pointer = {
            "schemaVersion": "joint-release-pointer.v1",
            "releaseId": release_id,
            "manifest": str(relative),
            "manifestSha256": _file_sha256(manifest_path),
            "updatedAt": datetime.now(UTC).isoformat(),
        }
        _atomic_json(pointer_path, pointer)
    return {"release": release, "pointer": pointer}


def activate_existing_shadow_release(
    *,
    registry_root: Path,
    target_release_id: str,
    expected_active_release_id: str,
) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", target_release_id):
        raise JointBundleError("JOINT_ROLLBACK_TARGET_INVALID")
    root = registry_root.expanduser().resolve()
    manifest_path = root / "releases" / target_release_id / "manifest.json"
    target = JointBundle(
        manifest_path.parent,
        require_ready=False,
    ).manifest
    if target.get("releaseStatus") != "SHADOW" or target.get("bundleId") != target_release_id:
        raise JointBundleError("JOINT_ROLLBACK_TARGET_INVALID")
    with _registry_lock(root):
        active = _active_pointer(root)
        active_id = active.get("releaseId") if active else None
        if active_id != expected_active_release_id:
            raise JointBundleError("JOINT_ACTIVE_RELEASE_CONFLICT")
        pointer = {
            "schemaVersion": "joint-release-pointer.v1",
            "releaseId": target_release_id,
            "manifest": str(manifest_path.relative_to(root)),
            "manifestSha256": _file_sha256(manifest_path),
            "updatedAt": datetime.now(UTC).isoformat(),
        }
        _atomic_json(root / "active-shadow.json", pointer)
    return {"release": target, "pointer": pointer}
