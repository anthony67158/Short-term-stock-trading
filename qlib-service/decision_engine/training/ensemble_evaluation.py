"""Evaluate a prediction-level three-seed decision ensemble."""

import argparse
import hashlib
import json
import os
import time

import numpy as np

from .evaluation import binary_metrics
from .bakeoff import (
    POC_SCHEMA_VERSION,
    combine_action_value_and_ranker,
    model_family,
    run_family_fold,
)
from .backtest_dataset import (
    build_poc_dataset,
    interval_expanding_folds,
)


ENSEMBLE_SCHEMA_VERSION = "decision-seed-ensemble-evaluation.v1"


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def empirical_percentiles(calibration_scores, values):
    calibration = np.sort(
        np.asarray(calibration_scores, dtype=np.float64)
    )
    target = np.asarray(values, dtype=np.float64)
    if (
        calibration.ndim != 1
        or target.ndim != 1
        or not len(calibration)
        or not np.isfinite(calibration).all()
        or not np.isfinite(target).all()
    ):
        raise ValueError("种子集成排序分无效")
    return np.searchsorted(
        calibration,
        target,
        side="right",
    ).astype(np.float64) / len(calibration)


def _matching(values, key):
    reference = values[0][key]
    if any(value[key] != reference for value in values[1:]):
        raise ValueError("种子集成切分不一致")
    return reference


def ensemble_fold(seed_folds):
    actions = [value["action"]["_selection"] for value in seed_folds]
    rankers = [value["ranking"]["_selection"] for value in seed_folds]
    validation = _matching(actions, "validation")
    calibration = _matching(actions, "calibration")
    _matching(rankers, "validation")
    _matching(rankers, "calibration")
    action_expected = np.mean([
        np.asarray(value["expectedNetR"], dtype=np.float64)
        for value in actions
    ], axis=0)
    calibration_action = np.mean([
        np.asarray(value["calibrationExpectedNetR"], dtype=np.float64)
        for value in actions
    ], axis=0)
    p_win = np.mean([
        np.asarray(value["calibratedPWin"], dtype=np.float64)
        for value in actions
    ], axis=0)
    global_p_win = np.mean([
        np.asarray(value["globalCalibratedPWin"], dtype=np.float64)
        for value in actions
    ], axis=0)
    rank_expected = np.mean([
        np.asarray(value["rankExpectedNetR"], dtype=np.float64)
        for value in rankers
    ], axis=0)
    calibration_rank_expected = np.mean([
        np.asarray(
            value["calibrationRankExpectedNetR"],
            dtype=np.float64,
        )
        for value in rankers
    ], axis=0)
    rank_percentiles = np.mean([
        empirical_percentiles(
            value["calibrationRankerScore"],
            value["rankerScore"],
        )
        for value in rankers
    ], axis=0)
    calibration_rank_percentiles = np.mean([
        empirical_percentiles(
            value["calibrationRankerScore"],
            value["calibrationRankerScore"],
        )
        for value in rankers
    ], axis=0)
    first = seed_folds[0]
    return {
        "action": {
            "fold": first["action"]["fold"],
            "metadata": first["action"]["metadata"],
            "_selection": {
                "validation": validation,
                "calibration": calibration,
                "expectedNetR": action_expected.tolist(),
                "calibrationExpectedNetR":
                    calibration_action.tolist(),
                "pWin": p_win.tolist(),
                "globalPWin": global_p_win.tolist(),
            },
        },
        "ranking": {
            "fold": first["ranking"]["fold"],
            "metadata": first["ranking"]["metadata"],
            "_selection": {
                "validation": validation,
                "calibration": calibration,
                "rankerScore": rank_percentiles.tolist(),
                "calibrationRankerScore":
                    calibration_rank_percentiles.tolist(),
                "rankExpectedNetR": rank_expected.tolist(),
                "calibrationRankExpectedNetR":
                    calibration_rank_expected.tolist(),
            },
        },
    }


def ensemble_eligibility(combination):
    folds = combination["folds"]
    fold_means = [
        float(value["ranking"]["top5"]["mean_net_r_at_5"])
        for value in folds
    ]
    fold_lower_bounds = [
        float(value["ranking"]["top5"]["netRLowerBound"])
        for value in folds
    ]
    aggregate_lower = float(combination["aggregate"]["top5LowerBound"])
    return (
        aggregate_lower > 0
        and min(fold_means) > 0
        and min(fold_lower_bounds) > 0
    )


def pwin_calibration_comparison(dataset, action_folds):
    fold_reports = []
    labels_all = []
    global_all = []
    stratified_all = []
    for fold in action_folds:
        selection = fold["_selection"]
        validation = np.asarray(
            selection["validation"],
            dtype=np.int64,
        )
        mask = np.isfinite(dataset["y_win"][validation])
        labels = dataset["y_win"][validation][mask].astype(np.int8)
        global_probability = np.asarray(
            selection["globalPWin"],
            dtype=np.float64,
        )[mask]
        stratified_probability = np.asarray(
            selection["pWin"],
            dtype=np.float64,
        )[mask]
        global_metrics = binary_metrics(labels, global_probability)
        stratified_metrics = binary_metrics(
            labels,
            stratified_probability,
        )
        for value in (global_metrics, stratified_metrics):
            value.pop("reliability", None)
        fold_reports.append({
            "fold": fold["fold"],
            "global": global_metrics,
            "stratified": stratified_metrics,
        })
        labels_all.extend(labels.tolist())
        global_all.extend(global_probability.tolist())
        stratified_all.extend(stratified_probability.tolist())
    global_metrics = binary_metrics(
        np.asarray(labels_all),
        np.asarray(global_all),
    )
    stratified_metrics = binary_metrics(
        np.asarray(labels_all),
        np.asarray(stratified_all),
    )
    for value in (global_metrics, stratified_metrics):
        value.pop("reliability", None)
    return {
        "folds": fold_reports,
        "aggregate": {
            "global": global_metrics,
            "stratified": stratified_metrics,
            "brierDelta": round(
                stratified_metrics["brier"]
                - global_metrics["brier"],
                6,
            ),
            "logLossDelta": round(
                stratified_metrics["log_loss"]
                - global_metrics["log_loss"],
                6,
            ),
        },
    }


def run_seed_ensemble(
    input_path,
    output_directory,
    *,
    seeds=(42, 7, 2026),
    folds_count=3,
    estimators=180,
    threads=4,
):
    dataset = build_poc_dataset(input_path)
    folds = interval_expanding_folds(
        dataset,
        n_splits=folds_count,
    )
    action_folds = []
    ranking_folds = []
    for fold_number, fold in enumerate(folds, 1):
        seed_folds = []
        for seed in seeds:
            print(json.dumps({
                "stage": "ENSEMBLE_FOLD",
                "fold": fold_number,
                "seed": seed,
            }), flush=True)
            action = run_family_fold(
                model_family("lightgbm", estimators, threads, seed),
                dataset,
                fold,
            )
            ranking = run_family_fold(
                model_family("catboost", estimators, threads, seed),
                dataset,
                fold,
            )
            action["fold"] = fold_number
            ranking["fold"] = fold_number
            seed_folds.append({
                "action": action,
                "ranking": ranking,
            })
        combined = ensemble_fold(seed_folds)
        action_folds.append(combined["action"])
        ranking_folds.append(combined["ranking"])
    combination = combine_action_value_and_ranker(
        dataset,
        action_folds,
        ranking_folds,
    )
    pwin_comparison = pwin_calibration_comparison(
        dataset,
        action_folds,
    )
    passed = ensemble_eligibility(combination)
    report = {
        "schemaVersion": ENSEMBLE_SCHEMA_VERSION,
        "baseSchemaVersion": POC_SCHEMA_VERSION,
        "generatedAt": int(time.time() * 1000),
        "dataset": {
            "sha256": _sha256(input_path),
            "samples": int(len(dataset["X"])),
            "dates": int(len(set(dataset["dates"].tolist()))),
            "features": int(dataset["X"].shape[1]),
        },
        "seeds": list(seeds),
        "combination": combination,
        "pWinCalibrationComparison": pwin_comparison,
        "decision": {
            "eligible": passed,
            "reason": (
                "预测级三种子集成的全部窗口与总体下界均为正"
                if passed
                else "预测级三种子集成仍存在负窗口或负下界"
            ),
        },
    }
    os.makedirs(output_directory, exist_ok=True)
    with open(
        os.path.join(output_directory, "report.json"),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--seeds", default="42,7,2026")
    parser.add_argument("--folds", type=int, default=3)
    parser.add_argument("--estimators", type=int, default=180)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    report = run_seed_ensemble(
        args.input,
        args.output_dir,
        seeds=tuple(
            int(value)
            for value in args.seeds.split(",")
            if value.strip()
        ),
        folds_count=args.folds,
        estimators=args.estimators,
        threads=args.threads,
    )
    print(json.dumps(report["decision"], ensure_ascii=False))


if __name__ == "__main__":
    main()
