"""Resumable CatBoost return-expert ablation on frozen combination folds."""

import argparse
import fcntl
import gc
import json
import os
from datetime import UTC, datetime
from pathlib import Path

import catboost
import numpy as np
from catboost import CatBoostRegressor

from platform_app.modules.experiments.quant_model_trainer import RANDOM_STATE, QuantModelError
from platform_app.modules.experiments.ranking_combination import (
    CANDIDATES,
    combination_scores,
    daily_percentiles,
    temporal_fusion_weights,
)
from platform_app.modules.experiments.ranking_combination_runner import (
    evaluate_scores,
    write_json,
)
from platform_app.modules.experiments.ranking_model_trainer import (
    GLOBAL_PERCENTILE_TARGET,
    _file_sha256,
    _verified_ranking_database,
    load_ranking_training_data,
)
from platform_app.modules.experiments.ranking_walk_forward import (
    block_bootstrap_interval,
    expanding_walk_forward_splits,
)
from platform_app.modules.experiments.ranking_window_runner import verified_base_predictions

CATBOOST_CANDIDATE = "catboost_return"
ALL_CANDIDATES = (*CANDIDATES, CATBOOST_CANDIDATE)


def fit_catboost(data, mask, iterations, threads):
    target = data.target_return[mask]
    lower, upper = np.quantile(target, [0.005, 0.995])
    weights = data.sample_weight[mask] / data.sample_weight[mask].mean()
    model = CatBoostRegressor(
        loss_function="RMSE",
        iterations=iterations,
        learning_rate=0.05,
        depth=6,
        l2_leaf_reg=1.0,
        random_seed=RANDOM_STATE,
        random_strength=1.0,
        thread_count=threads,
        allow_writing_files=False,
        verbose=False,
    )
    model.fit(data.x[mask], np.clip(target, lower, upper), sample_weight=weights)
    return model


def train_fold(data, train, fusion, test, root, iterations, threads):
    artifact = root / f"{CATBOOST_CANDIDATE}.cbm"
    predictions = root / f"{CATBOOST_CANDIDATE}.npz"
    receipt_path = root / f"{CATBOOST_CANDIDATE}.json"
    valid = False
    if receipt_path.exists() and artifact.exists() and predictions.exists():
        receipt = json.loads(receipt_path.read_text())
        valid = (
            receipt.get("modelSha256") == _file_sha256(artifact)
            and receipt.get("predictionsSha256") == _file_sha256(predictions)
            and receipt.get("trainEnd") == str(data.dates[train].max())
        )
    if not valid:
        model = fit_catboost(data, train, iterations, threads)
        temporary = artifact.with_suffix(".tmp")
        model.save_model(temporary, format="cbm")
        os.replace(temporary, artifact)
        with predictions.with_suffix(".tmp").open("wb") as stream:
            np.savez_compressed(
                stream,
                fusion=model.predict(data.x[fusion]).astype(np.float32),
                test=model.predict(data.x[test]).astype(np.float32),
            )
        os.replace(predictions.with_suffix(".tmp"), predictions)
        write_json(receipt_path, {
            "modelSha256": _file_sha256(artifact),
            "predictionsSha256": _file_sha256(predictions),
            "rows": int(train.sum()),
            "trainStart": str(data.dates[train].min()),
            "trainEnd": str(data.dates[train].max()),
        })
        del model
        gc.collect()
    with np.load(predictions, allow_pickle=False) as saved:
        return saved["fusion"].copy(), saved["test"].copy()


def run(dataset_root, base_root, output, *, iterations=120, threads=6):
    output.mkdir(parents=True, exist_ok=True)
    with (output / "run.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return _run_locked(
            dataset_root,
            base_root,
            output,
            iterations=iterations,
            threads=threads,
        )


def _run_locked(dataset_root, base_root, output, *, iterations, threads):
    manifest, _ = _verified_ranking_database(dataset_root)
    base_protocol_path = base_root / "protocol.json"
    base_report_path = base_root / "report.json"
    try:
        base_protocol = json.loads(base_protocol_path.read_text())
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise QuantModelError("COMBINATION_BASE_PROTOCOL_INVALID") from exc
    if (
        base_protocol.get("databaseSha256") != manifest["databaseSha256"]
        or tuple(base_protocol.get("candidates", ())) != CANDIDATES
        or base_protocol.get("target") != GLOBAL_PERCENTILE_TARGET
        or not base_report_path.is_file()
    ):
        raise QuantModelError("COMBINATION_BASE_PROTOCOL_INVALID")
    protocol = {
        "schemaVersion": "ranking-catboost-combination.v1",
        "databaseSha256": manifest["databaseSha256"],
        "datasetId": manifest["datasetId"],
        "target": GLOBAL_PERCENTILE_TARGET,
        "baseCandidates": list(CANDIDATES),
        "additionalCandidate": CATBOOST_CANDIDATE,
        "objective": "RMSE_CLIPPED_RETURN_0_5_TO_99_5_PERCENTILE",
        "iterations": iterations,
        "threads": threads,
        "seed": RANDOM_STATE,
        "earlyStopping": False,
        "fusion": "date-balanced-simplex-mse-50pct-equal-shrinkage",
        "comparisonStatus": "DEVELOPMENT_ONLY_PREVIOUSLY_OBSERVED_DATES",
        "baseExperiment": {
            "protocolSha256": _file_sha256(base_protocol_path),
            "reportSha256": _file_sha256(base_report_path),
        },
        "sourceSha256": _file_sha256(Path(__file__)),
        "versions": {"catboost": catboost.__version__, "numpy": np.__version__},
    }
    protocol_path = output / "protocol.json"
    if protocol_path.exists():
        if json.loads(protocol_path.read_text()) != protocol:
            raise QuantModelError("COMBINATION_CATBOOST_RESUME_PROTOCOL_MISMATCH")
    else:
        write_json(protocol_path, protocol)
    data, _ = load_ranking_training_data(dataset_root, target_policy=GLOBAL_PERCENTILE_TARGET)
    folds = expanding_walk_forward_splits(data.dates)
    write_json(output / "splits.json", {"folds": [fold.as_dict() for fold in folds]})
    all_records = []
    for fold in folds:
        root = output / f"fold-{fold.fold}"
        root.mkdir(exist_ok=True)
        train, fusion, test = fold.masks(data.dates)
        fusion_predictions = verified_base_predictions(base_root, fold, "fusion")
        test_predictions = verified_base_predictions(base_root, fold, "test")
        print(f"Training fold={fold.fold} model={CATBOOST_CANDIDATE}", flush=True)
        write_json(output / "status.json", {
            "state": "RUNNING",
            "fold": fold.fold,
            "model": CATBOOST_CANDIDATE,
            "updatedAt": datetime.now(UTC).isoformat(),
        })
        calibration_values, test_values = train_fold(
            data, train, fusion, test, root, iterations, threads,
        )
        fusion_predictions.append(calibration_values)
        test_predictions.append(test_values)
        calibration = daily_percentiles(data.dates[fusion], np.column_stack(fusion_predictions))
        held_out = daily_percentiles(data.dates[test], np.column_stack(test_predictions))
        weights = temporal_fusion_weights(
            calibration,
            data.target_rank[fusion],
            data.dates[fusion],
            model_train_end=fold.train_end,
            test_start=fold.test_start,
        )
        scores = combination_scores(
            held_out, weights, candidate_names=ALL_CANDIDATES,
        )
        scores["base_equal"] = held_out[:, : len(CANDIDATES)].mean(axis=1)
        records, union = evaluate_scores(data, test, scores, fold.fold)
        np.savez_compressed(
            root / "oof.npz",
            dates=data.dates[test],
            instruments=data.instruments[test],
            boards=data.boards[test],
            targetReturn=data.target_return[test],
            normalizedPredictions=held_out,
            weights=weights,
        )
        write_json(root / "evaluation.json", {
            "split": fold.as_dict(),
            "weights": dict(zip(ALL_CANDIDATES, weights.tolist(), strict=True)),
            "records": records,
            "releaseStatus": "UNAVAILABLE",
        })
        write_json(root / "candidate-union.json", {"candidates": union})
        all_records.extend(records)
        print(f"Completed fold={fold.fold} weights={weights.tolist()}", flush=True)
    names = sorted({row["model"] for row in all_records})
    baseline = np.array([
        row["top10GrossReturn"] for row in all_records if row["model"] == "base_equal"
    ])
    summaries = {}
    for name in names:
        rows = [row for row in all_records if row["model"] == name]
        gross = np.array([row["top10GrossReturn"] for row in rows])
        rank_ics = [row["rankIc"] for row in rows if row["rankIc"] is not None]
        summaries[name] = {
            "meanDailyRankIc": float(np.mean(rank_ics)) if rank_ics else None,
            "top10GrossReturn": float(gross.mean()),
            "versusBaseEqual": block_bootstrap_interval(gross - baseline),
        }
    report = {
        "releaseStatus": "UNAVAILABLE",
        "models": summaries,
        "blockers": [
            "MINUTE_EXECUTION_PENDING",
            "POSITION_AGENT_ABLATION_PENDING",
            "INDEPENDENT_FORWARD_CONFIRMATION_PENDING",
        ],
    }
    write_json(output / "report.json", report)
    write_json(output / "status.json", {
        "state": "COMPLETED",
        "releaseStatus": "UNAVAILABLE",
    })
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--base-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=120)
    parser.add_argument("--threads", type=int, default=6)
    arguments = parser.parse_args()
    run(
        arguments.dataset_root,
        arguments.base_root,
        arguments.output,
        iterations=arguments.iterations,
        threads=arguments.threads,
    )
