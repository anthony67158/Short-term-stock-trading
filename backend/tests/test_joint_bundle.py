import json
from datetime import timedelta

import pytest

from platform_app.contracts.base import utcnow
from platform_app.modules.experiments import joint_bundle
from platform_app.modules.experiments.joint_bundle import (
    AGENT_FEATURE_NAMES,
    JointBundle,
    JointBundleError,
    encode_agent_assessment,
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

    monkeypatch.setattr(joint_bundle, "RankingModelBundle", _Ranking)
    monkeypatch.setattr(joint_bundle, "QuantModelBundle", _Quant)
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

    manifest = write_joint_candidate(
        output_root=root,
        bundle_id="joint-v1",
        ranking_model_root=tmp_path / "ranking",
        quant_model_root=tmp_path / "quant",
        account_backtest_path=account_path,
        agent_model="gpt-5.6-terra",
    )

    assert manifest["releaseStatus"] == "UNAVAILABLE"
    assert (
        "PROSPECTIVE_AGENT_SAMPLE_SUPPORT_INSUFFICIENT"
        in manifest["releaseBlockers"]
    )
    assert "POSITION_ACTION_MODEL_MISSING" in manifest["releaseBlockers"]
    with pytest.raises(JointBundleError, match="JOINT_BUNDLE_NOT_RELEASED"):
        JointBundle(root)
    unavailable = JointBundle(root, require_ready=False).unavailable_decision()
    assert unavailable["status"] == "UNAVAILABLE"
    assert unavailable["action"] == "NONE"


def test_joint_candidate_rejects_mixed_component_lineage(tmp_path, monkeypatch):
    class _Ranking:
        manifest = {"bundleId": "ranking-v1", "artifactSha256": "a" * 64}

        def __init__(self, _root, *, require_ready):
            pass

    class _Quant:
        manifest = {"bundleId": "quant-v1", "artifactSha256": "b" * 64}

        def __init__(self, _root, *, require_ready):
            pass

    monkeypatch.setattr(joint_bundle, "RankingModelBundle", _Ranking)
    monkeypatch.setattr(joint_bundle, "QuantModelBundle", _Quant)
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
            account_backtest_path=account_path,
            agent_model="gpt-5.6-terra",
        )
