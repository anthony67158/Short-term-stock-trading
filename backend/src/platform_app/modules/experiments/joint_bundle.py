"""Versioned Agent feature contract and fail-closed joint release bundle."""

import hashlib
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path

from platform_app.modules.experiments.account_backtest import (
    ACCOUNT_BACKTEST_SCHEMA_VERSION,
)
from platform_app.modules.experiments.quant_model_bundle import QuantModelBundle
from platform_app.modules.experiments.ranking_model_bundle import RankingModelBundle
from platform_app.modules.research.agent import ASSESSMENT_TOOL, SEARCH_TOOL, SYSTEM
from platform_app.modules.research.contracts import (
    ASSESSMENT_PROTOCOL_VERSION,
    AssessmentOutput,
)

JOINT_SCHEMA_VERSION = "joint-bundle.v1"
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
    account_backtest_path: Path,
    agent_model: str,
) -> dict:
    root = output_root.resolve()
    manifest_path = root / "manifest.json"
    if manifest_path.exists():
        raise JointBundleError("JOINT_BUNDLE_ALREADY_EXISTS")
    ranking = RankingModelBundle(ranking_model_root, require_ready=False)
    quant = QuantModelBundle(quant_model_root, require_ready=False)
    account_backtest_path = account_backtest_path.resolve()
    try:
        account_report = json.loads(account_backtest_path.read_text())
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise JointBundleError("JOINT_ACCOUNT_REPORT_INVALID") from exc
    if (
        account_report.get("schemaVersion") != ACCOUNT_BACKTEST_SCHEMA_VERSION
        or account_report["lineage"]["rankingModelArtifactSha256"]
        != ranking.manifest["artifactSha256"]
        or account_report["lineage"]["quantModelArtifactSha256"]
        != quant.manifest["artifactSha256"]
    ):
        raise JointBundleError("JOINT_COMPONENT_LINEAGE_MISMATCH")
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
                "PROSPECTIVE_AGENT_SAMPLE_SUPPORT_INSUFFICIENT",
                "AGENT_QUALITY_EVALUATION_PENDING",
                "POSITION_ACTION_MODEL_MISSING",
            ]
        )
    )
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
            "accountBacktestSha256": _file_sha256(account_backtest_path),
        },
        "agent": {
            "model": agent_model,
            "protocolVersion": ASSESSMENT_PROTOCOL_VERSION,
            "featureSchemaVersion": AGENT_FEATURE_SCHEMA_VERSION,
            "featureNames": AGENT_FEATURE_NAMES,
            "promptSha256": _sha256_bytes(SYSTEM.encode()),
            "toolSchemaSha256": _sha256_bytes(tool_schema),
        },
        "missingArtifacts": [
            "prospective-agent-feature-dataset",
            "trained-joint-model",
            "position-action-model",
        ],
    }
    root.mkdir(parents=True, exist_ok=True)
    temporary = manifest_path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    os.replace(temporary, manifest_path)
    return manifest


class JointBundle:
    def __init__(self, root: Path, *, require_ready: bool = True):
        manifest_path = root.resolve() / "manifest.json"
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
            or tuple(self.manifest.get("agent", {}).get("featureNames", ()))
            != AGENT_FEATURE_NAMES
        ):
            raise JointBundleError("JOINT_BUNDLE_MANIFEST_INVALID")
        if require_ready and self.manifest.get("releaseStatus") != "READY":
            raise JointBundleError("JOINT_BUNDLE_NOT_RELEASED")

    def unavailable_decision(self) -> dict:
        if self.manifest.get("releaseStatus") == "READY":
            raise JointBundleError("JOINT_BUNDLE_READY_REQUIRES_DECISION_ENGINE")
        return {
            "status": "UNAVAILABLE",
            "action": "NONE",
            "reasonCodes": self.manifest["releaseBlockers"],
            "releaseId": self.manifest["bundleId"],
        }
