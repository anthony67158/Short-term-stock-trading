import json
import secrets
from datetime import date, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import delete

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.identity.models import User
from platform_app.modules.operations.models import Job, Outbox
from platform_app.modules.review import service, worker
from platform_app.modules.review.agent import (
    ReviewAgentFailure,
    validate_output,
)
from platform_app.modules.review.contracts import ReviewAgentOutput
from platform_app.modules.review.models import (
    ImprovementProposal,
    ReviewReport,
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
        db.execute(delete(Outbox).where(Outbox.owner_id == owner_id))
        db.execute(delete(Job).where(Job.owner_id == owner_id))
        db.execute(delete(User).where(User.id == owner_id))
