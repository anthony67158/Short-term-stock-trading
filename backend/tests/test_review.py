import json
import secrets
from datetime import date, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import delete, select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.experiments.models import StrategyVersion
from platform_app.modules.identity.models import User
from platform_app.modules.operations.models import Job, Outbox
from platform_app.modules.review import service, worker
from platform_app.modules.review.agent import (
    ReviewAgentFailure,
    validate_output,
)
from platform_app.modules.review.contracts import (
    ReviewAgentOutput,
    StrategyAgentOutput,
)
from platform_app.modules.review.models import (
    ImprovementProposal,
    ReviewReport,
)
from platform_app.modules.review.strategy_agent import (
    StrategyAgentFailure,
    validate_output as validate_strategy_output,
)
from platform_app.modules.review.strategy_compiler import (
    compile_strategy_proposal,
)


def _sample(sample_id, action, uncertainty=0):
    return SimpleNamespace(
        id=sample_id,
        scenario={"selectedAction": action},
        agent_features={"uncertaintyCount": uncertainty},
    )


def _outcome(
    returns,
    *,
    actual_status,
    reason,
    execution_delta=None,
):
    return SimpleNamespace(
        simulation_outcome={"actionNetReturns": returns},
        actual_execution_outcome={"status": actual_status},
        attribution={
            "actualExecutionEvaluation": {
                "reason": reason,
                "executionDeltaVsSelectedAction": execution_delta,
            }
        },
        source_dataset_id="market-v1",
    )


def test_review_snapshot_separates_strategy_and_user_non_execution():
    negative_id = new_id()
    missed_id = new_id()
    snapshot = service.build_review_snapshot(
        date(2026, 9, 15),
        [
            (
                _sample(negative_id, "ADD", uncertainty=2),
                _outcome(
                    {
                        "HOLD": "0.03",
                        "ADD": "-0.02",
                        "REDUCE": "0.01",
                        "EXIT": "0",
                    },
                    actual_status="EXECUTED",
                    reason="PARTIAL_EXECUTION",
                    execution_delta="-0.01",
                ),
            ),
            (
                _sample(missed_id, "ADD"),
                _outcome(
                    {
                        "HOLD": "0",
                        "ADD": "0.04",
                        "REDUCE": "-0.01",
                        "EXIT": "-0.02",
                    },
                    actual_status="NOT_EXECUTED",
                    reason="USER_DID_NOT_CREATE_PLAN",
                ),
            ),
        ],
        [
            SimpleNamespace(
                id=new_id(),
                exclusion_reason="ACTION_MINUTE_WINDOW_INCOMPLETE",
            )
        ],
    )
    clusters = {
        cluster.cluster_id: cluster
        for cluster in snapshot.failure_clusters
    }
    assert clusters["STRATEGY_NEGATIVE_RETURN"].source_sample_ids == [
        negative_id
    ]
    assert clusters["USER_NOT_EXECUTED"].source_sample_ids == [missed_id]
    assert (
        clusters["USER_NOT_EXECUTED"].strategy_failure_eligible
        is False
    )
    assert clusters["EXECUTION_DRAG"].category == "EXECUTION"
    assert snapshot.source_dataset_ids == ["market-v1"]
    assert {
        metric.metric_id: metric.value
        for metric in snapshot.metrics
    }["execution-eligible-rate"] == "0.50000000"


def test_review_agent_rejects_unsourced_references_and_numbers():
    sample_id = new_id()
    payload = {
        "metricSnapshot": {
            "metrics": [
                {
                    "metric_id": "mean-selected-net-return",
                    "source_sample_ids": [sample_id],
                }
            ],
            "failure_clusters": [
                {
                    "source_sample_ids": [sample_id],
                }
            ],
        }
    }
    valid = {
        "summary": "联合动作存在需要验证的收益弱化现象。",
        "conclusions": [
            {
                "kind": "HYPOTHESIS",
                "statement": "不确定性较高时可能需要收紧动作条件。",
                "metric_refs": ["mean-selected-net-return"],
                "source_sample_ids": [sample_id],
            }
        ],
        "proposals": [
            {
                "title": "复核决策阈值",
                "hypothesis": "收紧阈值可能减少弱证据动作。",
                "change_type": "DECISION_THRESHOLD",
                "direction": "INCREASE",
                "source_sample_ids": [sample_id],
            }
        ],
    }
    assert validate_output(
        json.dumps(valid, ensure_ascii=False),
        payload,
    ).proposals[0].source_sample_ids == [sample_id]
    invalid_reference = {
        **valid,
        "conclusions": [
            {
                **valid["conclusions"][0],
                "metric_refs": ["invented"],
            }
        ],
    }
    with pytest.raises(
        ReviewAgentFailure,
        match="INVALID_REVIEW_METRIC_REFERENCE",
    ):
        validate_output(
            json.dumps(invalid_reference, ensure_ascii=False),
            payload,
        )
    with pytest.raises(
        ReviewAgentFailure,
        match="REVIEW_TEXT_CONTAINS_UNSOURCED_NUMBER",
    ):
        validate_output(
            json.dumps(
                {**valid, "summary": "收益下降2.5%。"},
                ensure_ascii=False,
            ),
            payload,
        )


def test_strategy_agent_rejects_unregistered_parameter_values():
    payload = {
        "allowedParameters": {
            "minimumExpectedDeltaForAdd": {
                "allowedValues": ["0.005", "0.010"],
            }
        }
    }
    valid = {
        "status": "PROPOSED",
        "rationale": "提高加仓收益要求并在确认集验证。",
        "parameter_id": "minimumExpectedDeltaForAdd",
        "candidate_value": "0.010",
    }
    assert validate_strategy_output(
        json.dumps(valid, ensure_ascii=False),
        payload,
    ).candidate_value == "0.010"
    with pytest.raises(
        StrategyAgentFailure,
        match="STRATEGY_PARAMETER_NOT_ALLOWED",
    ):
        validate_strategy_output(
            json.dumps(
                {**valid, "candidate_value": "DROP TABLE"},
                ensure_ascii=False,
            ),
            payload,
        )


def test_review_worker_publishes_report_and_linked_proposal(monkeypatch):
    owner_id = new_id()
    job_id = new_id()
    sample_id = new_id()
    report_date = date(2026, 9, 15)
    snapshot = service.build_review_snapshot(
        report_date,
        [
            (
                _sample(sample_id, "ADD"),
                _outcome(
                    {
                        "HOLD": "0.01",
                        "ADD": "-0.02",
                        "REDUCE": "0",
                        "EXIT": "-0.01",
                    },
                    actual_status="NOT_EXECUTED",
                    reason="USER_DID_NOT_RECORD_EXECUTION",
                ),
            )
        ],
        [],
    )
    payload = {
        "request": {"review_date": report_date.isoformat()},
        "metricSnapshot": snapshot.model_dump(mode="json"),
        "protocolVersion": "review-agent.v1",
        "model": "synthetic-review",
        "asOf": utcnow().isoformat(),
        "deadline": (utcnow() + timedelta(minutes=5)).isoformat(),
    }
    with sessions().begin() as db:
        db.add(
            User(
                id=owner_id,
                username="review-" + secrets.token_hex(8),
                password_hash="synthetic",
            )
        )
        db.add(
            Job(
                id=job_id,
                owner_id=owner_id,
                kind="DAILY_REVIEW",
                business_key=new_id(),
                input_hash="a" * 64,
                payload=payload,
            )
        )
    output = ReviewAgentOutput(
        summary="联合动作弱于持有基线，需要实验验证。",
        conclusions=[
            {
                "kind": "OBSERVED",
                "statement": "结构化结果显示联合动作表现较弱。",
                "metricRefs": ["mean-selected-net-return"],
                "sourceSampleIds": [sample_id],
            }
        ],
        proposals=[
            {
                "title": "收紧动作阈值",
                "hypothesis": "更严格的收益要求可能降低错误动作。",
                "changeType": "DECISION_THRESHOLD",
                "direction": "INCREASE",
                "sourceSampleIds": [sample_id],
            }
        ],
    )
    with sessions()() as db:
        claimed = db.get(Job, job_id)
    monkeypatch.setattr(worker.jobs, "claim", lambda *_args, **_kwargs: claimed)
    monkeypatch.setattr(worker.jobs, "mark_external", lambda _job: True)
    monkeypatch.setattr(
        worker,
        "run_review_agent",
        lambda _payload: output,
    )

    def finish(job, _result=None, error=None, publish=None):
        assert error is None
        with sessions().begin() as db:
            current = db.get(Job, job.id)
            published = publish(db, current)
            current.status = "SUCCEEDED"
            current.result = published
        return True

    monkeypatch.setattr(worker.jobs, "finish", finish)
    assert worker.process_one() is True
    page = service.reports(owner_id, 10)
    assert len(page.reports) == 1
    report = page.reports[0]
    assert report.review_date == report_date
    assert report.proposals[0].source_sample_ids == [sample_id]
    assert report.proposals[0].status == "DRAFT"

    now = utcnow()
    strategy_id = new_id()
    strategy_job_id = new_id()
    with sessions().begin() as db:
        db.add(
            StrategyVersion(
                id=strategy_id,
                owner_id=owner_id,
                strategy_key="joint-review-test",
                version=1,
                status="EVALUATED",
                name="联合策略基线",
                hypothesis="量化与Agent联合改善费后收益",
                scope={
                    "market": "ALL_A_SHARES",
                    "horizon": "5_SESSIONS",
                },
                config={"decisionPolicyVersion": "position-decision.v1"},
                dataset={
                    "dataset_id": "market-v1",
                    "sha256": "b" * 64,
                },
                split={
                    "train_end": "20230109",
                    "calibration_start": "20230117",
                    "calibration_end": "20240805",
                    "confirmation_start": "20240813",
                    "confirmation_end": "20260908",
                    "embargo_sessions": 5,
                },
                release_policy={"minimumEffectiveSamples": 1},
                fee_policy_version="fees-v1",
                risk_policy_version="risk-v1",
                simulation_policy_version="position-outcome.v1",
                confirmation_set_id="confirmation-v1",
                minimum_effective_samples=1,
                config_hash="c" * 64,
                request_key=new_id(),
                request_hash="c" * 64,
                revision=2,
                frozen_at=now,
                evaluated_at=now,
            )
        )
        proposal = db.scalar(
            select(ImprovementProposal).where(
                ImprovementProposal.owner_id == owner_id
            )
        )
        strategy_payload = {
            "proposal": {
                "proposalId": proposal.id,
                "changeType": proposal.change_type,
                "direction": proposal.direction,
            },
            "baseStrategy": {"id": strategy_id},
            "allowedParameters": {
                "minimumExpectedDeltaForAdd": {
                    "allowedValues": ["0.005", "0.010"],
                }
            },
        }
        db.add(
            Job(
                id=strategy_job_id,
                owner_id=owner_id,
                kind="STRATEGY_PROPOSAL",
                business_key=new_id(),
                input_hash="d" * 64,
                payload=strategy_payload,
            )
        )
    strategy_output = StrategyAgentOutput(
        status="PROPOSED",
        rationale="提高加仓收益要求后再进行确认集检验。",
        parameter_id="minimumExpectedDeltaForAdd",
        candidate_value="0.010",
    )
    with sessions().begin() as db:
        result = compile_strategy_proposal(
            db,
            db.get(Job, strategy_job_id),
            strategy_output,
        )
    assert result["status"] == "COMPILED"
    with sessions()() as db:
        proposal = db.scalar(
            select(ImprovementProposal).where(
                ImprovementProposal.owner_id == owner_id
            )
        )
        strategy = db.get(
            StrategyVersion,
            proposal.compiled_strategy_version_id,
        )
        assert proposal.status == "COMPILED"
        assert strategy.status == "DRAFT"
        assert strategy.config["experimentParameters"] == {
            "minimumExpectedDeltaForAdd": "0.010"
        }

    with sessions().begin() as db:
        db.execute(
            delete(ImprovementProposal).where(
                ImprovementProposal.owner_id == owner_id
            )
        )
        db.execute(
            delete(ReviewReport).where(
                ReviewReport.owner_id == owner_id
            )
        )
        db.execute(
            delete(StrategyVersion).where(
                StrategyVersion.owner_id == owner_id
            )
        )
        db.execute(delete(Outbox).where(Outbox.owner_id == owner_id))
        db.execute(delete(Job).where(Job.owner_id == owner_id))
        db.execute(delete(User).where(User.id == owner_id))
