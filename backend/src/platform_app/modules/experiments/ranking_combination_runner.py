"""Resumable full-universe model comparison; run with python -m."""

import argparse
import fcntl
import gc
import json
import os
from datetime import UTC, datetime
from pathlib import Path

import joblib
import lightgbm
import numpy as np
from lightgbm import LGBMRanker, LGBMRegressor

from platform_app.modules.experiments.quant_model_trainer import RANDOM_STATE, QuantModelError
from platform_app.modules.experiments.ranking_combination import (
    CANDIDATES,
    combination_scores,
    daily_percentiles,
    temporal_fusion_weights,
)
from platform_app.modules.experiments.ranking_model_trainer import (
    GLOBAL_PERCENTILE_TARGET,
    MODEL_FEATURE_NAMES,
    _file_sha256,
    _group_sizes,
    _percentile_ranks,
    _relevance_labels,
    _verified_ranking_database,
    load_ranking_training_data,
)
from platform_app.modules.experiments.ranking_walk_forward import (
    block_bootstrap_interval,
    expanding_walk_forward_splits,
)


def write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")
    os.replace(temporary, path)


def fit_candidate(data, mask, name, iterations, threads):
    common = dict(
        learning_rate=0.05, n_estimators=iterations, num_leaves=31, max_depth=6,
        min_child_samples=200, reg_lambda=1.0, max_bin=63, deterministic=True,
        force_col_wise=True, random_state=RANDOM_STATE, n_jobs=threads, verbosity=-1,
    )
    # Fixed iteration budget: fusion labels never influence base fitting or stopping.
    weight = data.sample_weight[mask] / data.sample_weight[mask].mean()
    if name == "return":
        y = data.target_return[mask]
        lower, upper = np.quantile(y, [0.005, 0.995])
        model = LGBMRegressor(objective="regression", **common)
        model.fit(data.x[mask], np.clip(y, lower, upper), sample_weight=weight)
    else:
        levels = int(name.removeprefix("rank"))
        model = LGBMRanker(objective="lambdarank", label_gain=list(range(levels)), **common)
        model.fit(
            data.x[mask], _relevance_labels(data.target_rank[mask], levels=levels),
            sample_weight=weight, group=_group_sizes(data.dates[mask]),
        )
    return model


def evaluate_scores(data, test, scores, fold_number):
    dates, ids = data.dates[test], data.instruments[test]
    returns, boards = data.target_return[test], data.boards[test]
    records, union = [], []
    _, starts, counts = np.unique(dates, return_index=True, return_counts=True)
    for start, count in zip(starts, counts, strict=True):
        sl = slice(start, start + count)
        actual = _percentile_ranks(returns[sl])
        selected = {}
        for name, values in scores.items():
            local = values[sl]
            top = np.argsort(local, kind="stable")[-min(10, count):]
            correlation = (
                float(np.corrcoef(_percentile_ranks(local), actual)[0, 1])
                if np.std(local) > 0 and np.std(actual) > 0 else None
            )
            records.append({
                "fold": fold_number, "date": int(dates[start]), "model": name,
                "rankIc": correlation, "top10GrossReturn": float(returns[sl][top].mean()),
                "marketGrossReturn": float(returns[sl].mean()),
            })
            for index in top:
                selected.setdefault(int(index), []).append(name)
        for index, models in selected.items():
            union.append({
                "fold": fold_number, "decisionDate": str(dates[start]),
                "instrumentId": ids[start + index].decode(),
                "boardCode": int(boards[start + index]), "selectedBy": models,
            })
    return records, union


def run(dataset_root: Path, output: Path, *, iterations=120, threads=6):
    output.mkdir(parents=True, exist_ok=True)
    with (output / "run.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return _run_locked(dataset_root, output, iterations=iterations, threads=threads)


def _run_locked(dataset_root, output, *, iterations, threads):
    manifest, _ = _verified_ranking_database(dataset_root)
    if iterations < 1 or threads < 1:
        raise QuantModelError("COMBINATION_BUDGET_INVALID")
    dependencies = (
        "ranking_combination_runner.py", "ranking_combination.py",
        "ranking_model_trainer.py", "ranking_walk_forward.py", "quant_model_trainer.py",
    )
    protocol = {
        "schemaVersion": "ranking-combination.v1",
        "databaseSha256": manifest["databaseSha256"],
        "datasetId": manifest["datasetId"], "target": GLOBAL_PERCENTILE_TARGET,
        "candidates": list(CANDIDATES), "iterations": iterations, "threads": threads,
        "seed": RANDOM_STATE, "labelGain": "linear", "earlyStopping": False,
        "fusion": "date-balanced-simplex-mse-50pct-equal-shrinkage",
        "comparisonStatus": "DEVELOPMENT_ONLY_PREVIOUSLY_OBSERVED_DATES",
        "featureNames": list(MODEL_FEATURE_NAMES),
        "sourceHashes": {name: _file_sha256(Path(__file__).with_name(name))
                         for name in dependencies},
        "versions": {"numpy": np.__version__, "lightgbm": lightgbm.__version__,
                     "joblib": joblib.__version__},
    }
    protocol_path = output / "protocol.json"
    if protocol_path.exists():
        if json.loads(protocol_path.read_text()) != protocol:
            raise QuantModelError("COMBINATION_RESUME_PROTOCOL_MISMATCH")
    else:
        write_json(protocol_path, protocol)
    print("Loading sealed full-universe dataset", flush=True)
    data, _ = load_ranking_training_data(dataset_root, target_policy=GLOBAL_PERCENTILE_TARGET)
    folds = expanding_walk_forward_splits(data.dates)
    write_json(output / "splits.json", {"folds": [fold.as_dict() for fold in folds]})
    all_records = []
    for fold in folds:
        root = output / f"fold-{fold.fold}"
        root.mkdir(exist_ok=True)
        train, fusion, test = fold.masks(data.dates)
        fusion_predictions, test_predictions = [], []
        for name in CANDIDATES:
            artifact = root / f"{name}.joblib"
            predictions = root / f"{name}.npz"
            receipt = root / f"{name}.json"
            valid = False
            if receipt.exists() and artifact.exists() and predictions.exists():
                hashes = json.loads(receipt.read_text())
                valid = (
                    hashes.get("modelSha256") == _file_sha256(artifact)
                    and hashes.get("predictionsSha256") == _file_sha256(predictions)
                )
            if not valid:
                print(f"Training fold={fold.fold} model={name} rows={train.sum()}", flush=True)
                write_json(output / "status.json", {
                    "state": "RUNNING", "fold": fold.fold, "model": name,
                    "updatedAt": datetime.now(UTC).isoformat(),
                })
                model = fit_candidate(data, train, name, iterations, threads)
                temporary = artifact.with_suffix(".tmp")
                joblib.dump(model, temporary, compress=3)
                os.replace(temporary, artifact)
                with predictions.with_suffix(".tmp").open("wb") as stream:
                    np.savez_compressed(
                        stream, fusion=model.predict(data.x[fusion]).astype(np.float32),
                        test=model.predict(data.x[test]).astype(np.float32),
                    )
                os.replace(predictions.with_suffix(".tmp"), predictions)
                write_json(receipt, {
                    "modelSha256": _file_sha256(artifact),
                    "predictionsSha256": _file_sha256(predictions),
                    "trainEnd": fold.train_end, "rows": int(train.sum()),
                })
                del model
                gc.collect()
            with np.load(predictions, allow_pickle=False) as saved:
                fusion_predictions.append(saved["fusion"])
                test_predictions.append(saved["test"])
        calibration = daily_percentiles(data.dates[fusion], np.column_stack(fusion_predictions))
        held_out = daily_percentiles(data.dates[test], np.column_stack(test_predictions))
        weights = temporal_fusion_weights(
            calibration, data.target_rank[fusion], data.dates[fusion],
            model_train_end=fold.train_end, test_start=fold.test_start,
        )
        records, union = evaluate_scores(
            data, test, combination_scores(held_out, weights), fold.fold,
        )
        # Persist identity alignment so OOF can be used without relying on loader row order.
        np.savez_compressed(
            root / "oof.npz", dates=data.dates[test], instruments=data.instruments[test],
            boards=data.boards[test], targetReturn=data.target_return[test],
            normalizedPredictions=held_out, weights=weights,
        )
        write_json(root / "evaluation.json", {
            "split": fold.as_dict(), "weights": dict(zip(CANDIDATES, weights.tolist())),
            "records": records, "releaseStatus": "UNAVAILABLE",
        })
        write_json(root / "candidate-union.json", {"candidates": union})
        all_records.extend(records)
        print(f"Completed fold={fold.fold} weights={weights.tolist()}", flush=True)
    names = sorted({row["model"] for row in all_records})
    summaries = {}
    baseline = np.array([r["top10GrossReturn"] for r in all_records if r["model"] == "rank5"])
    for name in names:
        rows = [r for r in all_records if r["model"] == name]
        gross = np.array([r["top10GrossReturn"] for r in rows])
        ics = [r["rankIc"] for r in rows if r["rankIc"] is not None]
        summaries[name] = {
            "meanDailyRankIc": float(np.mean(ics)) if ics else None,
            "top10GrossReturn": float(gross.mean()),
            "versusRank5": block_bootstrap_interval(gross - baseline),
        }
    report = {
        "releaseStatus": "UNAVAILABLE", "models": summaries,
        "blockers": ["MINUTE_EXECUTION_PENDING", "POSITION_AGENT_ABLATION_PENDING",
                     "INDEPENDENT_FORWARD_CONFIRMATION_PENDING"],
    }
    write_json(output / "report.json", report)
    write_json(output / "status.json", {"state": "COMPLETED", "releaseStatus": "UNAVAILABLE"})
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=120)
    parser.add_argument("--threads", type=int, default=6)
    args = parser.parse_args()
    run(args.dataset_root, args.output, iterations=args.iterations, threads=args.threads)
