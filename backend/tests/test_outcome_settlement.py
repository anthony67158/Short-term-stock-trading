import hashlib
import json
import secrets
import sqlite3
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import delete, select, text

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.decisions.models import (
    DecisionContextRecord,
    DecisionRecord,
)
from platform_app.modules.experiments.outcome_settlement import (
    settle_prospective_outcomes,
)
from platform_app.modules.identity.models import User
from platform_app.modules.learning.models import (
    ProspectiveOutcome,
    ProspectiveSample,
)
from platform_app.modules.market.models import Instrument
from platform_app.modules.operations.models import Job
from platform_app.modules.portfolio.models import (
    Account,
    Execution,
    ExecutionPlan,
)
from platform_app.modules.research.models import Assessment


def _sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _market_dataset(tmp_path, *, include_minutes=True):
    root = tmp_path / "market"
    root.mkdir()
    database = root / "market.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE instruments (
                instrument_id TEXT PRIMARY KEY,
                exchange TEXT NOT NULL,
                board TEXT NOT NULL
            );
            CREATE TABLE trade_calendar (
                exchange TEXT NOT NULL,
                cal_date TEXT NOT NULL,
                is_open INTEGER NOT NULL
            );
            CREATE TABLE daily_bars (
                instrument_id TEXT NOT NULL,
                trade_date TEXT NOT NULL,
                open TEXT NOT NULL,
                close TEXT NOT NULL
            );
            CREATE TABLE adjustment_factors (
                instrument_id TEXT NOT NULL,
                trade_date TEXT NOT NULL,
                factor TEXT NOT NULL
            );
            CREATE TABLE minute_bars (
                instrument_id TEXT NOT NULL,
                bar_end_shanghai TEXT NOT NULL,
                volume_shares TEXT NOT NULL
            );
            """
        )
        connection.execute(
            "INSERT INTO instruments VALUES ('SZ.999990','SZ','MAIN')"
        )
        connection.executemany(
            "INSERT INTO trade_calendar VALUES ('SSE',?,1)",
            [("20260908",), ("20260909",), ("20260915",)],
        )
        connection.executemany(
            "INSERT INTO daily_bars VALUES ('SZ.999990',?,?,?)",
            [
                ("20260908", "10", "10"),
                ("20260909", "10", "10.2"),
                ("20260915", "11", "11"),
            ],
        )
        connection.executemany(
            "INSERT INTO adjustment_factors VALUES ('SZ.999990',?,'1')",
            [("20260908",), ("20260909",), ("20260915",)],
        )
        if include_minutes:
            connection.executemany(
                "INSERT INTO minute_bars VALUES ('SZ.999990',?,?)",
                [
                    (f"2026-09-09 {clock}", "100000")
                    for clock in (
                        "09:35:00",
                        "09:40:00",
                        "09:45:00",
                        "09:50:00",
                        "09:55:00",
                        "10:00:00",
                    )
                ],
            )
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": "market-dataset.v4",
                "datasetId": "market-test",
                "database": database.name,
                "databaseSha256": _sha256(database),
            }
        )
    )
    return root


@pytest.fixture
def prospective_scope():
    owner_id = new_id()
    account_id = new_id()
    job_id = new_id()
    assessment_id = new_id()
    sample_id = new_id()
    decision_id = new_id()
    now = utcnow()
    with sessions().begin() as db:
        db.add(
            User(
                id=owner_id,
                username="outcome-" + secrets.token_hex(8),
                password_hash="synthetic",
            )
        )
        db.add(
            Instrument(
                id="SZ.999990",
                code="999990",
                exchange="SZ",
                name="合成结算证券",
                board="MAIN",
                first_seen_at=now,
                last_seen_at=now,
                is_current=False,
            )
        )
        db.add(
            Account(
                id=account_id,
                owner_id=owner_id,
                name="合成结算账户",
                kind="SIMULATED",
                currency="CNY",
                max_position_percent=20,
                version=1,
                creation_key=new_id(),
                creation_hash="a" * 64,
                creation_result={},
            )
        )
        db.add(
            Job(
                id=job_id,
                owner_id=owner_id,
                kind="POSITION_EVALUATION",
                business_key=new_id(),
                input_hash="b" * 64,
                payload={},
            )
        )
        db.flush()
        db.add(
            Assessment(
                id=assessment_id,
                owner_id=owner_id,
                instrument_id="SZ.999990",
                job_id=job_id,
                protocol_version="position-assessment.v1",
                model_id="synthetic",
                as_of=now,
                input_hash="c" * 64,
                evidence_ids=[],
                output={},
                tool_trace=[],
            )
        )
        db.flush()
        db.add(
            ProspectiveSample(
                id=sample_id,
                owner_id=owner_id,
                account_id=account_id,
                instrument_id="SZ.999990",
                assessment_id=assessment_id,
                source_key=decision_id,
                request_hash="d" * 64,
                decision_context_hash="e" * 64,
                schema_version="prospective-position-sample.v1",
                decision_as_of=datetime(2026, 9, 8, 9, tzinfo=UTC),
                horizon_end_date=date(2026, 9, 15),
                market_snapshot_ref=(
                    "market-test:20260908:" + "f" * 64
                ),
                ranking_bundle_id="ranking-test",
                quant_bundle_id="quant-test",
                agent_protocol_version="position-assessment.v1",
                agent_feature_schema_version="position-agent-features.v1",
                agent_features={"thesisStatus": "SUPPORTED"},
                quant_prediction={
                    "values": [
                        {
                            "action": action,
                            "target_quantity_shares": target,
                            "expected_delta_return_vs_hold": expected,
                        }
                        for action, target, expected in (
                            ("HOLD", 1000, "0"),
                            ("ADD", 2000, "0.02"),
                            ("REDUCE", 500, "-0.01"),
                            ("EXIT", 0, "-0.02"),
                        )
                    ]
                },
                scenario={
                    "decisionStatus": "READY",
                    "selectedAction": "ADD",
                    "targetQuantityShares": 2000,
                },
                context={
                    "currentQuantityShares": 1000,
                    "sellableQuantityShares": 1000,
                },
                status="PENDING",
            )
        )
    yield {
        "ownerId": owner_id,
        "accountId": account_id,
        "jobId": job_id,
        "assessmentId": assessment_id,
        "sampleId": sample_id,
        "decisionId": decision_id,
    }
    with sessions().begin() as db:
        db.execute(
            text(
                "ALTER TABLE prospective_outcomes "
                "DISABLE TRIGGER prospective_outcome_immutable"
            )
        )
        try:
            db.execute(
                delete(ProspectiveOutcome).where(
                    ProspectiveOutcome.sample_id == sample_id
                )
            )
        finally:
            db.execute(
                text(
                    "ALTER TABLE prospective_outcomes "
                    "ENABLE TRIGGER prospective_outcome_immutable"
                )
            )
        db.execute(
            delete(Execution).where(Execution.account_id == account_id)
        )
        db.execute(
            delete(ExecutionPlan).where(
                ExecutionPlan.account_id == account_id
            )
        )
        db.execute(
            delete(ProspectiveSample).where(
                ProspectiveSample.id == sample_id
            )
        )
        db.execute(
            delete(DecisionRecord).where(
                DecisionRecord.owner_id == owner_id
            )
        )
        db.execute(
            delete(DecisionContextRecord).where(
                DecisionContextRecord.owner_id == owner_id
            )
        )
        db.execute(delete(Assessment).where(Assessment.id == assessment_id))
        db.execute(delete(Job).where(Job.id == job_id))
        db.execute(delete(Account).where(Account.id == account_id))
        db.execute(delete(Instrument).where(Instrument.id == "SZ.999990"))
        db.execute(delete(User).where(User.id == owner_id))


def _add_partial_execution(scope):
    context_id = new_id()
    plan_id = new_id()
    execution_id = new_id()
    with sessions().begin() as db:
        db.add(
            DecisionContextRecord(
                id=context_id,
                owner_id=scope["ownerId"],
                account_id=scope["accountId"],
                instrument_id="SZ.999990",
                account_version=1,
                release_id="joint-test",
                context_hash="1" * 64,
                snapshot={},
                assessment_ids=[scope["assessmentId"]],
                as_of=datetime(2026, 9, 8, 9, tzinfo=UTC),
            )
        )
        db.flush()
        db.add(
            DecisionRecord(
                id=scope["decisionId"],
                owner_id=scope["ownerId"],
                account_id=scope["accountId"],
                instrument_id="SZ.999990",
                context_id=context_id,
                schema_version="position-decision.v1",
                status="READY",
                action="ADD",
                account_version=1,
                release_id="joint-test",
                payload={},
                as_of=datetime(2026, 9, 8, 9, tzinfo=UTC),
                valid_until=datetime(2026, 9, 9, 9, tzinfo=UTC),
            )
        )
        db.flush()
        db.add(
            ExecutionPlan(
                id=plan_id,
                account_id=scope["accountId"],
                instrument_id="SZ.999990",
                decision_id=scope["decisionId"],
                source="SYSTEM_DECISION",
                side="BUY",
                quantity_shares=1000,
                limit_price=Decimal("10"),
                fee_budget=Decimal("10"),
                recorded_shares=100,
                reserved_cash=Decimal("0"),
                reserved_shares=0,
                status="PARTIALLY_RECORDED",
                revision=2,
                reason="合成部分成交",
                expires_at=datetime(2026, 9, 9, 9, tzinfo=UTC),
            )
        )
        db.flush()
        db.add(
            Execution(
                id=execution_id,
                account_id=scope["accountId"],
                instrument_id="SZ.999990",
                source_key=new_id(),
                command_key=new_id(),
                request_hash="2" * 64,
                fact_hash="3" * 64,
                side="BUY",
                quantity_shares=100,
                price=Decimal("10"),
                gross_amount=Decimal("1000"),
                total_fees=Decimal("5.01"),
                fees={
                    "commission": "5",
                    "stampTax": "0",
                    "transferFee": "0.01",
                    "otherFee": "0",
                    "basis": "ACTUAL",
                },
                cash_delta=Decimal("-1005.01"),
                realized_pnl=None,
                executed_at=datetime(2026, 9, 9, 2, tzinfo=UTC),
                source="合成成交",
                account_version=2,
                plan_id=plan_id,
            )
        )
    return execution_id


def test_settlement_keeps_counterfactual_separate_from_non_execution(
    tmp_path,
    prospective_scope,
):
    market = _market_dataset(tmp_path)
    report = settle_prospective_outcomes(
        market_dataset_root=market,
        owner_id=prospective_scope["ownerId"],
        as_of=datetime(2026, 9, 15, 10, tzinfo=UTC),
    )
    assert report["matured"] == 1
    with sessions()() as db:
        sample = db.get(ProspectiveSample, prospective_scope["sampleId"])
        outcome = db.get(ProspectiveOutcome, sample.id)
        assert sample.status == "MATURED"
        assert outcome.simulation_outcome["actionNetReturns"]["ADD"] > "0"
        assert outcome.actual_execution_outcome["status"] == "NOT_EXECUTED"
        actual = outcome.attribution["actualExecutionEvaluation"]
        assert actual["eligible"] is False
        assert actual["failure"] is None
        assert actual["reason"] == "USER_DID_NOT_CREATE_PLAN"
    repeated = settle_prospective_outcomes(
        market_dataset_root=market,
        owner_id=prospective_scope["ownerId"],
        as_of=datetime(2026, 9, 15, 10, tzinfo=UTC),
    )
    assert repeated["matured"] == 0


def test_settlement_attributes_partial_actual_execution(
    tmp_path,
    prospective_scope,
):
    execution_id = _add_partial_execution(prospective_scope)
    market = _market_dataset(tmp_path)
    settle_prospective_outcomes(
        market_dataset_root=market,
        owner_id=prospective_scope["ownerId"],
        as_of=datetime(2026, 9, 15, 10, tzinfo=UTC),
    )
    with sessions()() as db:
        outcome = db.get(
            ProspectiveOutcome,
            prospective_scope["sampleId"],
        )
        actual = outcome.actual_execution_outcome
        assert outcome.actual_execution_id == execution_id
        assert actual["status"] == "EXECUTED"
        assert actual["executionIds"] == [execution_id]
        assert actual["filledShares"] == 100
        assert actual["fillRate"] == "0.10000000"
        attribution = outcome.attribution["actualExecutionEvaluation"]
        assert attribution["eligible"] is True
        assert attribution["reason"] == "PARTIAL_EXECUTION"


def test_settlement_excludes_missing_market_facts(
    tmp_path,
    prospective_scope,
):
    market = _market_dataset(tmp_path, include_minutes=False)
    report = settle_prospective_outcomes(
        market_dataset_root=market,
        owner_id=prospective_scope["ownerId"],
        as_of=datetime(2026, 9, 15, 10, tzinfo=UTC),
    )
    assert report["matured"] == 0
    assert report["exclusionReasons"] == {
        "ACTION_MINUTE_WINDOW_INCOMPLETE": 1
    }
    with sessions()() as db:
        sample = db.get(ProspectiveSample, prospective_scope["sampleId"])
        assert sample.status == "EXCLUDED"
        assert db.scalar(
            select(ProspectiveOutcome).where(
                ProspectiveOutcome.sample_id == sample.id
            )
        ) is None
