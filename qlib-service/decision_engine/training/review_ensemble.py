"""Train and package the trigger-review CatBoost seed ensemble."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time

import numpy as np

from ..heads.review_contract import FEATURE_NAMES, FEATURE_SCHEMA_VERSION
from ..review_registry import (
    REVIEW_ARTIFACT_FILENAMES,
    REVIEW_ARTIFACT_SCHEMA_VERSION,
    REVIEW_MODEL_SCHEMA_VERSION,
    validate_review_metadata,
)
from .bakeoff import (
    CatBoostFamily,
    _probability,
    _ranking,
    active_feature_mask,
    clip_labels,
    compose_expected_net_r,
    constant_probability_metrics,
)
from .evaluation import (
    apply_probability_calibrator,
    binary_metrics,
    block_bootstrap_lower_bound,
    fit_probability_calibrator,
    regression_metrics,
)
from .review_bakeoff import load_dataset
from time_splits import three_way_purged_split


DEFAULT_SEEDS = (42, 7, 2026)


def _catboost_payload(model):
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "model.json")
        model.save_model(path, format="json")
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)


def _fit_member(dataset, development, calibration, seed, estimators, threads):
    family = CatBoostFamily(estimators, threads, seed)
    mask = active_feature_mask(dataset["X"][development])
    active = np.flatnonzero(mask)
    if not len(active):
        raise ValueError("触价复核训练集没有有效特征")
    X_development = dataset["X"][development][:, mask]
    X_calibration = dataset["X"][calibration][:, mask]
    positive = development[dataset["y_net_r"][development] > 0]
    negative = development[dataset["y_net_r"][development] <= 0]
    if not len(positive) or not len(negative):
        raise ValueError("触价复核训练集缺少正负收益样本")

    win_model = family.classifier()
    win_model.fit(X_development, dataset["y_win"][development])
    win_payoff = family.regressor()
    positive_labels, _ = clip_labels(dataset["y_net_r"][positive])
    win_payoff.fit(dataset["X"][positive][:, mask], positive_labels)
    loss_payoff = family.regressor()
    negative_labels, _ = clip_labels(dataset["y_net_r"][negative])
    loss_payoff.fit(dataset["X"][negative][:, mask], negative_labels)
    quantile = family.quantile()
    quantile_labels, _ = clip_labels(
        dataset["y_net_r"][development]
    )
    quantile.fit(X_development, quantile_labels)

    calibration_artifact = fit_probability_calibrator(
        dataset["y_win"][calibration],
        _probability(win_model, X_calibration),
    )
    raw_q10 = np.asarray(
        quantile.predict(X_calibration),
        dtype=np.float64,
    )
    q10_offset = float(np.quantile(
        dataset["y_net_r"][calibration] - raw_q10,
        0.1,
    ))
    return {
        "config": {
            "seed": int(seed),
            "activeFeatures": active.astype(int).tolist(),
            "pWinCalibration": calibration_artifact,
            "q10CalibrationOffset": round(q10_offset, 6),
        },
        "models": {
            "pWinGivenFill": win_model,
            "winPayoffR": win_payoff,
            "lossPayoffR": loss_payoff,
            "netRLower10": quantile,
        },
    }


def _member_predictions(member, matrix):
    active = np.asarray(
        member["config"]["activeFeatures"],
        dtype=np.int64,
    )
    selected = matrix[:, active]
    p_win = apply_probability_calibrator(
        _probability(
            member["models"]["pWinGivenFill"],
            selected,
        ),
        member["config"]["pWinCalibration"],
    )
    expected = compose_expected_net_r(
        p_win,
        member["models"]["winPayoffR"].predict(selected),
        member["models"]["lossPayoffR"].predict(selected),
    )
    q10 = (
        member["models"]["netRLower10"].predict(selected)
        + float(member["config"]["q10CalibrationOffset"])
    )
    return {
        "pWinGivenFill": p_win,
        "expectedNetR": expected,
        "netRLowerBound": np.minimum(q10, expected),
    }


def _evaluate(dataset, development, holdout, predictions):
    p_win = np.mean([
        value["pWinGivenFill"] for value in predictions
    ], axis=0)
    expected = np.mean([
        value["expectedNetR"] for value in predictions
    ], axis=0)
    lower = np.minimum(
        np.mean([
            value["netRLowerBound"] for value in predictions
        ], axis=0),
        expected,
    )
    win = binary_metrics(dataset["y_win"][holdout], p_win)
    win_baseline = constant_probability_metrics(
        dataset["y_win"][development],
        dataset["y_win"][holdout],
    )
    net = regression_metrics(dataset["y_net_r"][holdout], expected)
    median = np.full(
        len(holdout),
        float(np.median(dataset["y_net_r"][development])),
    )
    net_baseline = regression_metrics(
        dataset["y_net_r"][holdout],
        median,
    )
    risk_adjusted_value = 0.75 * expected + 0.25 * lower
    ranking = _ranking(
        dataset["y_net_r"][holdout],
        risk_adjusted_value,
        dataset,
        holdout,
        eligible_mask=expected > 0,
    )["top5"]
    coverage = float(np.mean(
        dataset["y_net_r"][holdout] >= lower
    ))
    metrics = {
        "samples": int(len(holdout)),
        "pWinBrier": win["brier"],
        "pWinBrierSkill": round(
            1 - win["brier"] / win_baseline["brier"],
            6,
        ),
        "netRMae": net["mae"],
        "netRMaeSkill": round(
            1 - net["mae"] / net_baseline["mae"],
            6,
        ),
        "positiveExpectedCoverage": round(
            float(np.mean(expected > 0)),
            6,
        ),
        "valueTop5MeanNetR": ranking["mean_net_r_at_5"],
        "valueTop5LowerBound": block_bootstrap_lower_bound(
            ranking["daily_net_r"],
            samples=5000,
            random_state=42,
        ),
        "q10Coverage": round(coverage, 6),
    }
    blockers = []
    if metrics["pWinBrierSkill"] <= 0:
        blockers.append("pWin Brier未优于常数基线")
    if metrics["netRMaeSkill"] <= 0:
        blockers.append("净R MAE未优于中位数基线")
    if metrics["valueTop5LowerBound"] <= 0:
        blockers.append("Top5净R下界未转正")
    if not 0.88 <= metrics["q10Coverage"] <= 0.92:
        blockers.append("Q10覆盖率不在88%-92%")
    return metrics, blockers


def train_review_ensemble(
    input_path,
    output_directory,
    *,
    seeds=DEFAULT_SEEDS,
    estimators=180,
    threads=4,
):
    dataset = load_dataset(input_path)
    if len(dataset["X"]) < 500 or len(set(dataset["dates"])) < 30:
        raise ValueError("触价复核训练数据不足")
    development, calibration, holdout, split = three_way_purged_split(
        dataset["dates"],
        calibration_fraction=0.15,
        holdout_fraction=0.15,
        purge_dates=5,
    )
    members = [
        _fit_member(
            dataset,
            development,
            calibration,
            seed,
            estimators,
            threads,
        )
        for seed in seeds
    ]
    predictions = [
        _member_predictions(member, dataset["X"][holdout])
        for member in members
    ]
    metrics, blockers = _evaluate(
        dataset,
        development,
        holdout,
        predictions,
    )
    model_version = (
        f"decision-review.{int(time.time())}.ensemble{len(members)}"
    )
    actual = dataset["y_net_r"][development]
    expected_shortfall = float(np.mean(
        actual[actual <= np.quantile(actual, 0.1)]
    ))
    metadata = {
        "schemaVersion": REVIEW_MODEL_SCHEMA_VERSION,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureNames": list(FEATURE_NAMES),
        "predictionContract": "trigger-review-action-value.v1",
        "modelVersion": model_version,
        "ensembleSize": len(members),
        "ensembleMembers": [
            member["config"] for member in members
        ],
        "calibrationSampleCount": int(len(calibration)),
        "productionEligible": not blockers,
        "baselineSelected": False,
        "rankingPolicy": {
            "schemaVersion": "review-ranking.v1",
            "expectedNetRWeight": 0.75,
            "netRLowerBoundWeight": 0.25,
            "eligibility": "expectedNetR>0",
        },
        "risk": {
            "expectedShortfall10": round(expected_shortfall, 6),
        },
        "validation": {
            "split": split,
            "metrics": metrics,
            "blockers": blockers,
            "holdoutStartDate": str(dataset["dates"][holdout][0]),
            "holdoutEndDate": str(dataset["dates"][holdout][-1]),
        },
    }
    validate_review_metadata(metadata)
    artifact = {
        "schemaVersion": REVIEW_ARTIFACT_SCHEMA_VERSION,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "members": [{
            "seed": member["config"]["seed"],
            "models": {
                name: _catboost_payload(model)
                for name, model in member["models"].items()
            },
        } for member in members],
    }
    os.makedirs(output_directory, exist_ok=True)
    for slot, payload in (
        ("ensemble", artifact),
        ("meta", metadata),
    ):
        with open(
            os.path.join(
                output_directory,
                REVIEW_ARTIFACT_FILENAMES[slot],
            ),
            "w",
            encoding="utf-8",
        ) as handle:
            json.dump(
                payload,
                handle,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
    return metadata


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--seeds", default="42,7,2026")
    parser.add_argument("--estimators", type=int, default=180)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    metadata = train_review_ensemble(
        args.input,
        args.output_dir,
        seeds=tuple(
            int(value)
            for value in args.seeds.split(",")
            if value.strip()
        ),
        estimators=args.estimators,
        threads=args.threads,
    )
    print(json.dumps({
        "modelVersion": metadata["modelVersion"],
        "productionEligible": metadata["productionEligible"],
        "blockers": metadata["validation"]["blockers"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
