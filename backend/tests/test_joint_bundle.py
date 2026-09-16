import json
from datetime import timedelta

import pytest

from platform_app.contracts.base import utcnow
from platform_app.modules.experiments import joint_bundle
from platform_app.modules.experiments.joint_bundle import (
    AGENT_FEATURE_NAMES,
    JointBundle,
    JointBundleError,
    activate_existing_shadow_release,
    encode_agent_assessment,
    publish_shadow_release,
    write_joint_candidate,
)


def _assessment():
    return {
        "summary": "合成研判",
        "claims": [
            {
                "kind": "OBSERVED",
                "statement": "合成事实",
                "evidence_ids": ["evidence-1"],
            },
            {
                "kind": "INFERRED",
                "statement": "合成推断",
                "evidence_ids": ["evidence-1"],
            },
        ],
        "counter_claims": [
            {
                "kind": "HYPOTHESIS",
                "statement": "合成反证",
                "evidence_ids": ["evidence-2"],
            }
        ],
        "thesis_status": "WEAKENED",
        "strategy_fit": ["QUALITY", "EVENT"],
        "uncertainties": ["仍需核验"],
        "invalidation": "证据失效",
        "next_check": "复核公告",
        "valid_until": (utcnow() + timedelta(hours=1)).isoformat(),
    }


def _experiment_artifacts(tmp_path):
    strategy = tmp_path / "strategy.json"
    strategy.write_text(
        json.dumps(
            {
                "schemaVersion": "strategy-freeze.v1",
                "strategyVersionId": "strategy-v1",
                "status": "EVALUATED",
                "configHash": "f" * 64,
            }
        )
    )
    ablation = tmp_path / "ablation.json"
    ablation.write_text(
        json.dumps(
            {
                "schemaVersion": "four-way-ablation.v1",
                "experimentId": "experiment-v1",
                "strategyVersionId": "strategy-v1",
                "configHash": "f" * 64,
                "evaluationStatus": "INSUFFICIENT",
            }
        )
    )
    return strategy, ablation


def test_agent_feature_encoding_is_fixed_and_does_not_include_prose():
    features = encode_agent_assessment(_assessment())

    assert tuple(features) == AGENT_FEATURE_NAMES
    assert features["thesisWeakened"] == 1
    assert features["strategyQuality"] == 1
    assert features["strategyEvent"] == 1
    assert features["observedClaimCount"] == 1
    assert features["inferredClaimCount"] == 1
    assert features["hypothesisClaimCount"] == 1
    assert features["counterClaimCount"] == 1
    assert features["uniqueEvidenceCount"] == 2


def test_joint_candidate_is_fail_closed_and_binds_component_hashes(
    tmp_path,
    monkeypatch,
):
    class _Ranking:
        manifest = {
            "bundleId": "ranking-v1",
            "artifactSha256": "a" * 64,
            "rankingDatabaseSha256": "d" * 64,
        }

        def __init__(self, _root, *, require_ready):
            assert require_ready is False

    class _Quant:
        manifest = {
            "bundleId": "quant-v1",
            "artifactSha256": "b" * 64,
        }

        def __init__(self, _root, *, require_ready):
            assert require_ready is False

    class _Position:
        manifest = {
            "bundleId": "position-v1",
            "artifactSha256": "p" * 64,
            "rankingDatabaseSha256": "d" * 64,
            "releaseBlockers": ["POSITION_VALUE_MODEL_NO_POSITIVE_LIFT"],
        }

        def __init__(self, _root, *, require_ready):
            assert require_ready is False

    monkeypatch.setattr(joint_bundle, "RankingModelBundle", _Ranking)
    monkeypatch.setattr(joint_bundle, "QuantModelBundle", _Quant)
    monkeypatch.setattr(joint_bundle, "PositionActionBundle", _Position)
    account_path = tmp_path / "account.json"
    account_path.write_text(
        json.dumps(
            {
                "schemaVersion": "account-backtest.v1",
                "releaseBlockers": ["BOARD_STRESS_RETURN_NOT_POSITIVE"],
                "lineage": {
                    "rankingModelArtifactSha256": "a" * 64,
                    "quantModelArtifactSha256": "b" * 64,
                },
            }
        )
    )
    root = tmp_path / "joint"
    strategy, ablation = _experiment_artifacts(tmp_path)

    manifest = write_joint_candidate(
        output_root=root,
        bundle_id="joint-v1",
        ranking_model_root=tmp_path / "ranking",
        quant_model_root=tmp_path / "quant",
        position_model_root=tmp_path / "position",
        account_backtest_path=account_path,
        strategy_artifact_path=strategy,
        ablation_artifact_path=ablation,
        agent_model="gpt-5.6-terra",
    )

    assert manifest["releaseStatus"] == "UNAVAILABLE"
    assert "PROSPECTIVE_AGENT_SAMPLE_SUPPORT_INSUFFICIENT" in manifest["releaseBlockers"]
    assert "POSITION_VALUE_MODEL_NO_POSITIVE_LIFT" in manifest["releaseBlockers"]
    with pytest.raises(JointBundleError, match="JOINT_BUNDLE_NOT_RELEASED"):
        JointBundle(root)
    unavailable = JointBundle(root, require_ready=False).unavailable_decision()
    assert unavailable["status"] == "UNAVAILABLE"
    assert unavailable["action"] == "NONE"


def test_joint_candidate_rejects_mixed_component_lineage(tmp_path, monkeypatch):
    class _Ranking:
        manifest = {
            "bundleId": "ranking-v1",
            "artifactSha256": "a" * 64,
            "rankingDatabaseSha256": "d" * 64,
        }

        def __init__(self, _root, *, require_ready):
            pass

    class _Quant:
        manifest = {"bundleId": "quant-v1", "artifactSha256": "b" * 64}

        def __init__(self, _root, *, require_ready):
            pass

    class _Position:
        manifest = {
            "bundleId": "position-v1",
            "artifactSha256": "p" * 64,
            "rankingDatabaseSha256": "d" * 64,
            "releaseBlockers": [],
        }

        def __init__(self, _root, *, require_ready):
            pass

    monkeypatch.setattr(joint_bundle, "RankingModelBundle", _Ranking)
    monkeypatch.setattr(joint_bundle, "QuantModelBundle", _Quant)
    monkeypatch.setattr(joint_bundle, "PositionActionBundle", _Position)
    account_path = tmp_path / "account.json"
    account_path.write_text(
        json.dumps(
            {
                "schemaVersion": "account-backtest.v1",
                "releaseBlockers": [],
                "lineage": {
                    "rankingModelArtifactSha256": "c" * 64,
                    "quantModelArtifactSha256": "b" * 64,
                },
            }
        )
    )

    with pytest.raises(
        JointBundleError,
        match="JOINT_COMPONENT_LINEAGE_MISMATCH",
    ):
        write_joint_candidate(
            output_root=tmp_path / "joint",
            bundle_id="joint-v1",
            ranking_model_root=tmp_path / "ranking",
            quant_model_root=tmp_path / "quant",
            position_model_root=tmp_path / "position",
            account_backtest_path=account_path,
            strategy_artifact_path=tmp_path / "strategy.json",
            ablation_artifact_path=tmp_path / "ablation.json",
            agent_model="gpt-5.6-terra",
        )


def test_shadow_publish_verifies_components_and_atomically_points_to_release(
    tmp_path,
    monkeypatch,
):
    class _Bundle:
        def __init__(self, root, *, require_ready):
            assert require_ready is False
            name = root.name
            values = {
                "ranking": ("ranking-v1", "a" * 64),
                "quant": ("quant-v1", "b" * 64),
                "position": ("position-v1", "c" * 64),
            }
            bundle_id, artifact = values[name]
            self.manifest = {
                "bundleId": bundle_id,
                "artifactSha256": artifact,
            }

    monkeypatch.setattr(joint_bundle, "RankingModelBundle", _Bundle)
    monkeypatch.setattr(joint_bundle, "QuantModelBundle", _Bundle)
    monkeypatch.setattr(joint_bundle, "PositionActionBundle", _Bundle)
    account = tmp_path / "account.json"
    account.write_text('{"synthetic":true}')
    account_hash = joint_bundle._file_sha256(account)
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    strategy, ablation = _experiment_artifacts(candidate)
    strategy_hash = joint_bundle._file_sha256(strategy)
    ablation_hash = joint_bundle._file_sha256(ablation)
    (candidate / "manifest.json").write_text(
        json.dumps(
            {
                "bundleId": "joint-candidate-v2",
                "schemaVersion": "joint-bundle.v2",
                "releaseStatus": "UNAVAILABLE",
                "releaseBlockers": ["JOINT_ABLATION_PENDING"],
                "decisionFallback": {
                    "status": "UNAVAILABLE",
                    "action": "NONE",
                    "allowsNewRisk": False,
                },
                "components": {
                    "rankingModelBundleId": "ranking-v1",
                    "rankingModelArtifactSha256": "a" * 64,
                    "quantModelBundleId": "quant-v1",
                    "quantModelArtifactSha256": "b" * 64,
                    "positionModelBundleId": "position-v1",
                    "positionModelArtifactSha256": "c" * 64,
                    "accountBacktestSha256": account_hash,
                    "strategyVersionId": "strategy-v1",
                    "strategyConfigHash": "f" * 64,
                    "strategyArtifact": "strategy.json",
                    "strategyArtifactSha256": strategy_hash,
                    "ablationExperimentId": "experiment-v1",
                    "ablationArtifact": "ablation.json",
                    "ablationArtifactSha256": ablation_hash,
                },
                "agent": {
                    "model": "gpt-synthetic",
                    "protocolVersion": "research-assessment.v1",
                    "featureSchemaVersion": "agent-features.v1",
                    "featureNames": AGENT_FEATURE_NAMES,
                    "promptSha256": "d" * 64,
                    "positionPromptSha256": "f" * 64,
                    "toolSchemaSha256": "e" * 64,
                },
                "missingArtifacts": ["prospective-agent-feature-dataset"],
            }
        )
    )
    registry = tmp_path / "registry"
    result = publish_shadow_release(
        candidate_root=candidate,
        registry_root=registry,
        release_id="joint-shadow-v1",
        ranking_model_root=tmp_path / "ranking",
        quant_model_root=tmp_path / "quant",
        position_model_root=tmp_path / "position",
        account_backtest_path=account,
    )
    assert result["release"]["releaseStatus"] == "SHADOW"
    assert result["release"]["allowsNewRisk"] is False
    pointer = registry / "active-shadow.json"
    bundle = JointBundle(pointer, require_ready=False)
    assert bundle.position_release().status == "SHADOW"
    assert bundle.position_release().allows_new_risk is False
    with pytest.raises(
        JointBundleError,
        match="JOINT_ACTIVE_RELEASE_CONFLICT",
    ):
        publish_shadow_release(
            candidate_root=candidate,
            registry_root=registry,
            release_id="joint-shadow-v2",
            ranking_model_root=tmp_path / "ranking",
            quant_model_root=tmp_path / "quant",
            position_model_root=tmp_path / "position",
            account_backtest_path=account,
        )
    second = publish_shadow_release(
        candidate_root=candidate,
        registry_root=registry,
        release_id="joint-shadow-v2",
        ranking_model_root=tmp_path / "ranking",
        quant_model_root=tmp_path / "quant",
        position_model_root=tmp_path / "position",
        account_backtest_path=account,
        expected_active_release_id="joint-shadow-v1",
    )
    assert second["pointer"]["releaseId"] == "joint-shadow-v2"
    rolled_back = activate_existing_shadow_release(
        registry_root=registry,
        target_release_id="joint-shadow-v1",
        expected_active_release_id="joint-shadow-v2",
    )
    assert rolled_back["pointer"]["releaseId"] == "joint-shadow-v1"
