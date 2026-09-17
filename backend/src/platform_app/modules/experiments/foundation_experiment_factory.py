"""Freeze the registered 100 CNY foundation-return experiment from sealed data."""

import argparse
import hashlib
import json
import os
from pathlib import Path

from platform_app.modules.experiments.foundation_market_cap_dataset import (
    verify_foundation_market_cap_dataset,
)
from platform_app.modules.experiments.foundation_return_contract import (
    FoundationReturnContractError,
    FoundationReturnExperiment,
    freeze_experiment,
)
from platform_app.modules.experiments.foundation_return_dataset import (
    verify_foundation_return_dataset,
)
from platform_app.modules.experiments.foundation_sampling_dataset import (
    verify_foundation_sampling_dataset,
)

MODEL_SOURCES = (
    {
        "role": "PRIMARY",
        "modelId": "ibm-granite/granite-timeseries-ttm-r2",
        "sourceKind": "HUGGING_FACE",
        "sourceUrl": (
            "https://huggingface.co/ibm-granite/"
            "granite-timeseries-ttm-r2"
        ),
        "revision": "cd2ad2a54ba5531fbcf6ba3b7a763a6e14223680",
        "license": "Apache-2.0",
        "adaptation": "FROZEN_BACKBONE",
    },
    {
        "role": "TEACHER",
        "modelId": "google/timesfm-2.5-200m-pytorch",
        "sourceKind": "HUGGING_FACE",
        "sourceUrl": (
            "https://huggingface.co/google/timesfm-2.5-200m-pytorch"
        ),
        "revision": "1d952420fba87f3c6dee4f240de0f1a0fbc790e3",
        "license": "Apache-2.0",
        "adaptation": "FROZEN",
    },
    {
        "role": "TEACHER",
        "modelId": "amazon/chronos-2",
        "sourceKind": "HUGGING_FACE",
        "sourceUrl": "https://huggingface.co/amazon/chronos-2",
        "revision": "29ec3766d36d6f73f0696f85560a422f50e8498c",
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
)


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _write_immutable_json(path: Path, payload: dict | list) -> None:
    rendered = json.dumps(
        payload,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    ) + "\n"
    if path.exists():
        if path.read_text() != rendered:
            raise FoundationReturnContractError(
                f"FOUNDATION_ARTIFACT_RESUME_MISMATCH:{path.name}",
            )
        return
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(rendered)
    os.replace(temporary, path)


def _write_initial_cost_ledger(path: Path, experiment_id: str) -> None:
    payload = {
        "schemaVersion": "foundation-cost-ledger-entry.v1",
        "sequence": 0,
        "event": "BUDGET_OPENED",
        "experimentId": experiment_id,
        "currency": "CNY",
        "spentCny": "0.00",
        "hardStopCny": "90.00",
        "totalLimitCny": "100.00",
    }
    rendered = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ) + "\n"
    if path.exists():
        if path.read_text() != rendered:
            raise FoundationReturnContractError(
                "FOUNDATION_ARTIFACT_RESUME_MISMATCH:cost-ledger.jsonl",
            )
        return
    temporary = path.with_suffix(".jsonl.tmp")
    temporary.write_text(rendered)
    os.replace(temporary, path)


def build_registered_experiment(
    *,
    foundation_dataset_root: Path,
    market_cap_dataset_root: Path,
    sampling_dataset_root: Path,
) -> FoundationReturnExperiment:
    foundation, _foundation_database = verify_foundation_return_dataset(
        foundation_dataset_root,
    )
    market_cap, _market_cap_database = verify_foundation_market_cap_dataset(
        market_cap_dataset_root,
    )
    sampling, _sampling_database = verify_foundation_sampling_dataset(
        sampling_dataset_root,
    )
    if (
        market_cap.get("foundationDatabaseSha256")
        != foundation["databaseSha256"]
        or sampling.get("foundationDatabaseSha256")
        != foundation["databaseSha256"]
        or sampling.get("marketCapDatabaseSha256")
        != market_cap["databaseSha256"]
        or sampling.get("rankingDatabaseSha256")
        != foundation["rankingDataset"]["databaseSha256"]
    ):
        raise FoundationReturnContractError(
            "FOUNDATION_EXPERIMENT_LINEAGE_MISMATCH",
        )
    folds = [
        {
            key: fold[key]
            for key in (
                "fold",
                "trainEnd",
                "probabilityCalibrationStart",
                "probabilityCalibrationEnd",
                "conformalCalibrationStart",
                "conformalCalibrationEnd",
                "testStart",
                "testEnd",
                "purgeSessions",
                "embargoSessions",
            )
        }
        for fold in sampling["folds"]
    ]
    fifth = folds[-1]
    return FoundationReturnExperiment.model_validate(
        {
            "experimentKey": "foundation-return-100rmb-v1",
            "confirmationSetId": (
                "foundation-return-confirmation-"
                f"{fifth['testStart']}-{fifth['testEnd']}-v1"
            ),
            "dataset": {
                "datasetId": foundation["datasetId"],
                "databaseSha256": foundation["databaseSha256"],
                "marketCapDatabaseSha256": market_cap["databaseSha256"],
                "samplingDatabaseSha256": sampling["databaseSha256"],
                "splitManifestSha256": _file_sha256(
                    sampling_dataset_root.expanduser().resolve()
                    / "split-manifest.json"
                ),
                "featureSchemaSha256": foundation["featureSchemaSha256"],
                "labelPolicySha256": foundation["labelPolicySha256"],
                "samplingPolicySha256": sampling["policySha256"],
                "feePolicyVersion": foundation["feePolicyVersion"],
                "executionPolicyVersion": "short-horizon-label-simulation.v2",
                "target": "r_net_5d",
                "historySessions": foundation["historySessions"],
            },
            "models": MODEL_SOURCES,
            "training": {
                "folds": folds,
                "seeds": [17, 29, 43],
                "quantiles": [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95],
                "finalConfirmationFold": 5,
                "maxTrainingWindowsPerFold": sampling[
                    "maximumWindowsPerFold"
                ],
                "historySessions": foundation["historySessions"],
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
    )


def freeze_registered_experiment(
    root: Path,
    *,
    foundation_dataset_root: Path,
    market_cap_dataset_root: Path,
    sampling_dataset_root: Path,
) -> dict:
    experiment = build_registered_experiment(
        foundation_dataset_root=foundation_dataset_root,
        market_cap_dataset_root=market_cap_dataset_root,
        sampling_dataset_root=sampling_dataset_root,
    )
    frozen = freeze_experiment(root, experiment)
    _write_immutable_json(
        root.expanduser().resolve() / "model-sources.json",
        {
            "schemaVersion": "foundation-model-sources.v1",
            "experimentId": frozen["experimentId"],
            "models": list(MODEL_SOURCES),
        },
    )
    _write_immutable_json(
        root.expanduser().resolve() / "split-manifest.json",
        verify_foundation_sampling_dataset(sampling_dataset_root)[0],
    )
    _write_initial_cost_ledger(
        root.expanduser().resolve() / "cost-ledger.jsonl",
        frozen["experimentId"],
    )
    return frozen


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--foundation-root", type=Path, required=True)
    parser.add_argument("--market-cap-root", type=Path, required=True)
    parser.add_argument("--sampling-root", type=Path, required=True)
    args = parser.parse_args()
    payload = freeze_registered_experiment(
        args.root,
        foundation_dataset_root=args.foundation_root,
        market_cap_dataset_root=args.market_cap_root,
        sampling_dataset_root=args.sampling_root,
    )
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
