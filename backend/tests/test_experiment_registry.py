import secrets
from types import SimpleNamespace

import pytest
from sqlalchemy import delete

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id
from platform_app.modules.experiments import service
from platform_app.modules.experiments.contracts import (
    ExperimentInput,
    FreezeStrategyInput,
    StrategyVersionInput,
)
from platform_app.modules.experiments.models import Experiment, StrategyVersion
from platform_app.modules.identity.models import User
from platform_app.modules.identity.service import create_user
from platform_app.modules.operations.models import Outbox


def strategy_input(minimum=2):
    return StrategyVersionInput(
        strategy_key="joint-short-horizon",
        name="联合短周期策略",
        hypothesis="量化价值参考与Agent证据研判联合后改善费后收益。",
        scope={"market": "ALL_A_SHARES", "horizon": "5_SESSIONS"},
        config={"decisionPolicyVersion": "position-decision.v1"},
        dataset={"datasetId": "prospective-v1", "sha256": "a" * 64},
        split={
            "trainEnd": "20230109",
            "calibrationStart": "20230117",
            "calibrationEnd": "20240805",
            "confirmationStart": "20240813",
            "confirmationEnd": "20260908",
            "embargoSessions": 5,
        },
        release_policy={
            "minimumEffectiveSamples": minimum,
            "confidenceLevel": "0.95",
        },
        fee_policy_version="a-share-cash-equity-fees.v1",
        risk_policy_version="position-risk.v1",
        simulation_policy_version="position-outcome.v1",
        confirmation_set_id="prospective-confirmation-v1",
        minimum_effective_samples=minimum,
    )


@pytest.fixture
def owner():
    owner_id = create_user(
        "experiment-test-" + new_id(),
        secrets.token_urlsafe(24),
    )
    yield owner_id
    with sessions().begin() as db:
        db.execute(delete(Outbox).where(Outbox.owner_id == owner_id))
        db.execute(delete(Experiment).where(Experiment.owner_id == owner_id))
        db.execute(delete(StrategyVersion).where(StrategyVersion.owner_id == owner_id))
        db.execute(delete(User).where(User.id == owner_id))


def test_strategy_freeze_and_insufficient_experiment_are_auditable(owner):
    key = new_id()
    draft = service.create_strategy_version(owner, strategy_input(), key)
    assert draft.status == "DRAFT"
    assert draft.version == 1
    assert service.create_strategy_version(owner, strategy_input(), key).id == draft.id
    with pytest.raises(service.ExperimentError, match="已有版本"):
        service.create_strategy_version(
            owner,
            strategy_input(),
            new_id(),
        )
    frozen = service.freeze_strategy_version(
        owner,
        draft.id,
        FreezeStrategyInput(expected_revision=1),
    )
    assert frozen.status == "FROZEN"
    assert frozen.revision == 2

    experiment = service.create_experiment(
        owner,
        ExperimentInput(strategy_version_id=draft.id),
        new_id(),
    )
    assert experiment.status == "FAILED"
    assert experiment.failure_code == "MATURED_SAMPLE_SUPPORT_INSUFFICIENT"
    assert experiment.result.evaluation_status == "INSUFFICIENT"
    assert experiment.result.effective_samples == 0
    assert set(experiment.result.variants) == {
        "JOINT",
        "NO_AGENT",
        "NO_QUANT",
        "FORMULA",
    }
    assert service.strategy_version(owner, draft.id).status == "EVALUATED"
    assert service.experiments(owner, 10).experiments[0].id == experiment.id


def test_four_way_ablation_uses_same_outcomes_and_discloses_comparators():
    strategy = StrategyVersion(
        dataset={"dataset_id": "prospective-v1", "sha256": "a" * 64},
        confirmation_set_id="confirmation-v1",
        minimum_effective_samples=2,
    )
    rows = [
        (
            SimpleNamespace(
                scenario={"selectedAction": "ADD"},
                quant_prediction={
                    "values": [
                        {
                            "action": "HOLD",
                            "expected_delta_return_vs_hold": "0",
                        },
                        {
                            "action": "ADD",
                            "expected_delta_return_vs_hold": "0.02",
                        },
                    ]
                },
                agent_features={"thesisStatus": "SUPPORTED"},
            ),
            SimpleNamespace(
                simulation_outcome={
                    "actionNetReturns": {
                        "HOLD": "0.01",
                        "ADD": "0.04",
                        "REDUCE": "0.02",
                        "EXIT": "-0.01",
                    }
                }
            ),
        ),
        (
            SimpleNamespace(
                scenario={"selectedAction": "NONE"},
                quant_prediction={
                    "values": [
                        {
                            "action": "HOLD",
                            "expectedDeltaReturnVsHold": "0",
                        },
                        {
                            "action": "REDUCE",
                            "expectedDeltaReturnVsHold": "0.03",
                        },
                    ]
                },
                agent_features={"thesisStatus": "INVALIDATED"},
            ),
            SimpleNamespace(
                simulation_outcome={
                    "actionNetReturns": {
                        "HOLD": "-0.02",
                        "ADD": "-0.05",
                        "REDUCE": "0.01",
                        "EXIT": "0.03",
                    }
                }
            ),
        ),
    ]

    result = service.evaluate_four_way_ablation(rows, strategy)

    assert result.evaluation_status == "VALID"
    assert result.effective_samples == 2
    assert result.variants["JOINT"].mean_net_return == "0.01000000"
    assert result.variants["NO_AGENT"].mean_net_return == "0.02500000"
    assert result.variants["NO_QUANT"].mean_net_return == "0.03500000"
    assert result.variants["FORMULA"].mean_net_return == "-0.00500000"
    assert result.comparator_policy["FORMULA"] == "HOLD_EXISTING_POSITION_V1"
