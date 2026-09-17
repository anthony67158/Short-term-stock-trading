import json

import pytest
from pydantic import ValidationError

from platform_app.modules.experiments.foundation_return_contract import (
    FoundationReturnContractError,
    FoundationReturnExperiment,
    canonical_experiment_json,
    experiment_config_sha256,
    experiment_id,
    freeze_experiment,
    load_frozen_experiment,
)


def folds():
    result = []
    for fold in range(1, 6):
        year = 2020 + fold
        result.append(
            {
                "fold": fold,
                "trainEnd": f"{year - 1}1231",
                "probabilityCalibrationStart": f"{year}0106",
                "probabilityCalibrationEnd": f"{year}0129",
                "conformalCalibrationStart": f"{year}0208",
                "conformalCalibrationEnd": f"{year}0226",
                "testStart": f"{year}0308",
                "testEnd": f"{year}0331",
                "purgeSessions": 5,
                "embargoSessions": 5,
            }
        )
    return result


def models():
    return [
        {
            "role": "PRIMARY",
            "modelId": "ibm-granite/granite-timeseries-ttm-r2",
            "sourceKind": "HUGGING_FACE",
            "sourceUrl": "https://huggingface.co/ibm-granite/granite-timeseries-ttm-r2",
            "revision": "1" * 40,
            "license": "Apache-2.0",
            "adaptation": "FROZEN_BACKBONE",
        },
        {
            "role": "TEACHER",
            "modelId": "google/timesfm-2.5-200m-pytorch",
            "sourceKind": "HUGGING_FACE",
            "sourceUrl": "https://huggingface.co/google/timesfm-2.5-200m-pytorch",
            "revision": "2" * 40,
            "license": "Apache-2.0",
            "adaptation": "FROZEN",
        },
        {
            "role": "TEACHER",
            "modelId": "amazon/chronos-2",
            "sourceKind": "HUGGING_FACE",
            "sourceUrl": "https://huggingface.co/amazon/chronos-2",
            "revision": "3" * 40,
            "license": "Apache-2.0",
            "adaptation": "FROZEN",
        },
        {
            "role": "BASELINE",
            "modelId": "catboost",
            "sourceKind": "PYPI",
            "sourceUrl": "https://pypi.org/project/catboost/",
            "revision": "1.2.10",
            "license": "Apache-2.0",
            "adaptation": "FROM_SCRATCH",
        },
        {
            "role": "BASELINE",
            "modelId": "xgboost",
            "sourceKind": "PYPI",
            "sourceUrl": "https://pypi.org/project/xgboost/",
            "revision": "3.4.1",
            "license": "Apache-2.0",
            "adaptation": "FROM_SCRATCH",
        },
        {
            "role": "BASELINE",
            "modelId": "lightgbm",
            "sourceKind": "PYPI",
            "sourceUrl": "https://pypi.org/project/lightgbm/",
            "revision": "4.7.0",
            "license": "MIT",
            "adaptation": "FROM_SCRATCH",
        },
    ]


def experiment_input():
    return {
        "experimentKey": "foundation-return-100rmb-v1",
        "confirmationSetId": "foundation-return-confirmation-v1",
        "dataset": {
            "datasetId": "full-universe-foundation-v1",
            "databaseSha256": "a" * 64,
            "marketCapDatabaseSha256": "d" * 64,
            "samplingDatabaseSha256": "e" * 64,
            "splitManifestSha256": "f" * 64,
            "featureSchemaSha256": "b" * 64,
            "labelPolicySha256": "c" * 64,
            "samplingPolicySha256": "1" * 64,
            "feePolicyVersion": "a-share-cash-equity-fees.v1",
            "executionPolicyVersion": "position-outcome.v1",
            "target": "r_net_5d",
            "historySessions": 90,
        },
        "models": models(),
        "training": {
            "folds": folds(),
            "seeds": [17, 29, 43],
            "quantiles": [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95],
            "finalConfirmationFold": 5,
            "maxTrainingWindowsPerFold": 1_500_000,
            "historySessions": 90,
            "internalValidationSessions": 63,
            "maxEpochs": 20,
            "earlyStoppingPatience": 3,
            "effectiveBatchSize": 256,
            "maxTrainableParameters": 5_000_000,
            "maxTrainableFraction": 0.20,
        },
        "budget": {
            "currency": "CNY",
            "totalLimit": "100.00",
            "plannedGpuLimit": "60.00",
            "persistentStorageLimit": "10.00",
            "dataTransferLimit": "5.00",
            "retryLimit": "15.00",
            "contingencyReserve": "10.00",
            "hardStopSpend": "90.00",
            "providerUnitPriceLimit": "1.32",
            "plannedPaidGpuHours": "45.00",
        },
        "releasePolicy": {
            "defaultStatus": "UNAVAILABLE",
            "allowProductionPointerUpdate": False,
            "requireStatisticalGate": True,
            "requireExecutionGate": True,
            "requireCapacityGate": True,
            "requirePositionGate": True,
            "requireAgentGate": True,
            "requireIndependentForwardGate": True,
        },
    }


def test_contract_has_stable_hash_and_identifier():
    experiment = FoundationReturnExperiment.model_validate(experiment_input())
    restored = FoundationReturnExperiment.model_validate(
        experiment.model_dump(mode="json", by_alias=True),
    )

    assert canonical_experiment_json(experiment) == canonical_experiment_json(restored)
    assert experiment_config_sha256(experiment) == experiment_config_sha256(restored)
    assert experiment_id(experiment).startswith("foundation-return-100rmb-v1-")
    assert experiment.release_policy.default_status == "UNAVAILABLE"
    assert experiment.release_policy.allow_production_pointer_update is False


def test_contract_rejects_budget_that_cannot_fund_planned_hours():
    raw = experiment_input()
    raw["budget"]["plannedPaidGpuHours"] = "46.00"

    with pytest.raises(ValidationError, match="计划 GPU 小时超过有效 GPU 预算"):
        FoundationReturnExperiment.model_validate(raw)


def test_contract_rejects_model_roster_or_mutable_hugging_face_revision():
    missing_teacher = experiment_input()
    missing_teacher["models"][2]["role"] = "BASELINE"
    missing_teacher["models"][2]["adaptation"] = "FROM_SCRATCH"
    with pytest.raises(ValidationError, match="必须配置两个固定教师"):
        FoundationReturnExperiment.model_validate(missing_teacher)

    mutable_revision = experiment_input()
    mutable_revision["models"][0]["revision"] = "main"
    with pytest.raises(ValidationError, match="不可变 commit revision"):
        FoundationReturnExperiment.model_validate(mutable_revision)


def test_contract_rejects_duplicate_seeds_and_non_expanding_folds():
    duplicate_seeds = experiment_input()
    duplicate_seeds["training"]["seeds"] = [17, 17, 43]
    with pytest.raises(ValidationError, match="随机种子必须互不重复"):
        FoundationReturnExperiment.model_validate(duplicate_seeds)

    non_expanding = experiment_input()
    non_expanding["training"]["folds"][1]["trainEnd"] = "20201230"
    with pytest.raises(ValidationError, match="必须按时间扩展"):
        FoundationReturnExperiment.model_validate(non_expanding)


def test_freeze_is_idempotent_and_rejects_drift(tmp_path):
    experiment = FoundationReturnExperiment.model_validate(experiment_input())
    frozen = freeze_experiment(tmp_path, experiment)

    assert freeze_experiment(tmp_path, experiment) == frozen
    assert load_frozen_experiment(tmp_path) == experiment
    assert frozen["releaseStatus"] == "UNAVAILABLE"

    changed_raw = experiment_input()
    changed_raw["training"]["effectiveBatchSize"] = 128
    changed = FoundationReturnExperiment.model_validate(changed_raw)
    with pytest.raises(
        FoundationReturnContractError,
        match="FOUNDATION_EXPERIMENT_RESUME_MISMATCH",
    ):
        freeze_experiment(tmp_path, changed)

    path = tmp_path / "experiment.json"
    tampered = json.loads(path.read_text())
    tampered["configHash"] = "0" * 64
    path.write_text(json.dumps(tampered))
    with pytest.raises(
        FoundationReturnContractError,
        match="FOUNDATION_EXPERIMENT_FREEZE_INVALID",
    ):
        load_frozen_experiment(tmp_path)
