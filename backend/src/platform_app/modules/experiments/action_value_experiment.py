"""Run and persist the development-only action-value walk-forward experiment."""

import json
import os
from pathlib import Path

import joblib

from platform_app.modules.experiments.action_value_training import (
    load_enriched_action_value_training_data,
)
from platform_app.modules.experiments.action_value_walk_forward import (
    ActionValueWalkForwardConfig,
    run_action_value_walk_forward,
)
from platform_app.modules.experiments.quant_model_trainer import _file_sha256

SCHEMA_VERSION = "action-value-experiment.v1"


class ActionValueExperimentError(ValueError):
    pass


def write_action_value_experiment(
    *,
    episode_dataset_root: Path,
    label_dataset_root: Path,
    ranking_dataset_root: Path,
    output_root: Path,
    factor_dataset_root: Path | None = None,
    feature_set: str = "technical",
    config: ActionValueWalkForwardConfig | None = None,
) -> dict:
    output_root = output_root.expanduser().resolve()
    manifest_path = output_root / "manifest.json"
    if output_root.exists():
        raise ActionValueExperimentError("ACTION_VALUE_EXPERIMENT_OUTPUT_EXISTS")
    training, lineage = load_enriched_action_value_training_data(
        episode_dataset_root=episode_dataset_root,
        label_dataset_root=label_dataset_root,
        ranking_dataset_root=ranking_dataset_root,
        factor_dataset_root=factor_dataset_root,
        feature_set=feature_set,
    )
    result = run_action_value_walk_forward(training, config=config)
    output_root.mkdir(parents=True, exist_ok=False)
    report_path = output_root / "evaluation.json"
    report_path.write_text(
        json.dumps(result.report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    artifacts = []
    for fold in result.artifacts:
        path = output_root / f"fold-{fold.fold.fold}.joblib"
        joblib.dump(fold, path, compress=3)
        artifacts.append(
            {
                "fold": fold.fold.fold,
                "path": path.name,
                "sha256": _file_sha256(path),
            }
        )
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "releaseStatus": "UNAVAILABLE",
        "productionEligible": False,
        "evaluation": report_path.name,
        "evaluationSha256": _file_sha256(report_path),
        "foldArtifacts": artifacts,
        "featureSet": feature_set,
        "featureNames": list(training.feature_names),
        "lineage": lineage,
        "gate": result.report["gate"],
        "nextStep": (
            "RUN_MINUTE_ACCOUNT_AND_AGENT_GATES"
            if result.report["gate"]["passed"]
            else "KEEP_REJECTED"
        ),
    }
    temporary = manifest_path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    os.replace(temporary, manifest_path)
    return manifest
