"""Train and package the trigger-review CatBoost seed ensemble."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time

import numpy as np

from ..heads.review_contract import (
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    REVIEW_PRICE_CONTRACT_SCHEMA_VERSION,
)
from ..review_registry import (
    REVIEW_ARTIFACT_FILENAMES,
    REVIEW_ARTIFACT_SCHEMA_VERSION,
    REVIEW_EXIT_POLICY_VERSION,
    REVIEW_ENTRY_TIMING,
    REVIEW_LABEL_CONTRACT_VERSION,
    REVIEW_MODEL_SCHEMA_VERSION,
    REVIEW_OBSERVATION_DURATION_MS,
    REVIEW_OBSERVATION_POLICY_VERSION,
    REVIEW_PREDICTION_CONTRACT,
    REVIEW_RISK_PROFILE_VERSION,
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
from time_splits import four_way_interval_split


DEFAULT_SEEDS = (42, 7, 2026)


def _catboost_payload(model):
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "model.json")
        model.save_model(path, format="json")
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)


def _fit_member(
    dataset,
    development,
    calibration,
    fill_development,
    fill_calibration,
    seed,
    estimators,
    threads,
):
    mask = active_feature_mask(dataset["X"][development])
    fill_mask = active_feature_mask(
        dataset["X_all"][fill_development]
    )
    active = np.flatnonzero(mask)
    active_fill = np.flatnonzero(fill_mask)
    if not len(active) or not len(active_fill):
        raise ValueError("触价复核训练集没有有效特征")
    X_development = dataset["X"][development][:, mask]
    X_calibration = dataset["X"][calibration][:, mask]
    positive = development[dataset["y_net_r"][development] > 0]
    negative = development[dataset["y_net_r"][development] <= 0]
    if not len(positive) or not len(negative):
        raise ValueError("触价复核训练集缺少正负收益样本")
    if len(set(dataset["y_fill"][fill_development].tolist())) < 2:
        raise ValueError("触价复核成交训练集缺少正负样本")

    family = CatBoostFamily(estimators, threads, seed)
    fill_model = family.classifier()
    fill_model.fit(
        dataset["X_all"][fill_development][:, fill_mask],
        dataset["y_fill"][fill_development],
    )
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

    fill_calibration_artifact = fit_probability_calibrator(
        dataset["y_fill"][fill_calibration],
        _probability(
            fill_model,
            dataset["X_all"][fill_calibration][:, fill_mask],
        ),
    )
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
            "activeFillFeatures": active_fill.astype(int).tolist(),
            "pFillCalibration": fill_calibration_artifact,
            "pWinCalibration": calibration_artifact,
            "q10CalibrationOffset": round(q10_offset, 6),
        },
        "models": {
            "pFill": fill_model,
            "pWinGivenFill": win_model,
            "winPayoffR": win_payoff,
            "lossPayoffR": loss_payoff,
            "netRLower10": quantile,
        },
    }


def _member_predictions(member, matrix):
    active_fill = np.asarray(
        member["config"]["activeFillFeatures"],
        dtype=np.int64,
    )
    active = np.asarray(
        member["config"]["activeFeatures"],
        dtype=np.int64,
    )
    selected = matrix[:, active]
    p_fill = apply_probability_calibrator(
        _probability(
            member["models"]["pFill"],
            matrix[:, active_fill],
        ),
        member["config"]["pFillCalibration"],
    )
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
        "pFill": p_fill,
        "pWinGivenFill": p_win,
        "expectedNetR": expected,
        "netRLowerBound": np.minimum(q10, expected),
    }


def _evaluate_fill(dataset, development, holdout, predictions):
    p_fill = np.mean([
        value["pFill"] for value in predictions
    ], axis=0)
    metrics = binary_metrics(dataset["y_fill"][holdout], p_fill)
    baseline = constant_probability_metrics(
        dataset["y_fill"][development],
        dataset["y_fill"][holdout],
    )
    brier_skill = round(
        1 - metrics["brier"] / baseline["brier"],
        6,
    )
    return {
        "pFillBrier": metrics["brier"],
        "pFillBrierSkill": brier_skill,
        "pFillCalibration": metrics["reliability"],
    }, (
        [] if brier_skill > 0 else ["pFill Brier未优于常数基线"]
    )


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
    if (
        len(dataset["X"]) < 500
        or len(dataset["X_all"]) < 500
        or len(set(dataset["dates"])) < 30
        or len(set(dataset["dates_all"])) < 30
    ):
        raise ValueError("触价复核训练数据不足")
    (
        development,
        calibration,
        selection,
        confirmation,
        split,
    ) = four_way_interval_split(
        dataset["dates"],
        dataset["label_start_ms"],
        dataset["label_end_ms"],
        dataset["event_group_ids"],
        calibration_fraction=0.15,
        selection_fraction=0.15,
        confirmation_fraction=0.15,
        embargo_dates=5,
    )
    (
        fill_development,
        fill_calibration,
        fill_selection,
        fill_confirmation,
        fill_split,
    ) = four_way_interval_split(
        dataset["dates_all"],
        dataset["label_start_ms_all"],
        dataset["label_end_ms_all"],
        dataset["event_group_ids_all"],
        calibration_fraction=0.15,
        selection_fraction=0.15,
        confirmation_fraction=0.15,
        embargo_dates=5,
    )
    members = [
        _fit_member(
            dataset,
            development,
            calibration,
            fill_development,
            fill_calibration,
            seed,
            estimators,
            threads,
        )
        for seed in seeds
    ]
    selection_predictions = [
        _member_predictions(member, dataset["X"][selection])
        for member in members
    ]
    selection_metrics, selection_blockers = _evaluate(
        dataset,
        development,
        selection,
        selection_predictions,
    )
    fill_selection_predictions = [
        _member_predictions(member, dataset["X_all"][fill_selection])
        for member in members
    ]
    fill_selection_metrics, fill_selection_blockers = _evaluate_fill(
        dataset,
        fill_development,
        fill_selection,
        fill_selection_predictions,
    )
    selection_metrics.update(fill_selection_metrics)
    confirmation_predictions = [
        _member_predictions(member, dataset["X"][confirmation])
        for member in members
    ]
    confirmation_metrics, confirmation_blockers = _evaluate(
        dataset,
        development,
        confirmation,
        confirmation_predictions,
    )
    fill_confirmation_predictions = [
        _member_predictions(member, dataset["X_all"][fill_confirmation])
        for member in members
    ]
    (
        fill_confirmation_metrics,
        fill_confirmation_blockers,
    ) = _evaluate_fill(
        dataset,
        fill_development,
        fill_confirmation,
        fill_confirmation_predictions,
    )
    confirmation_metrics.update(fill_confirmation_metrics)
    blockers = [
        *[f"候选选择段: {value}" for value in selection_blockers],
        *[f"候选选择段: {value}" for value in fill_selection_blockers],
        *[f"最终确认段: {value}" for value in confirmation_blockers],
        *[
            f"最终确认段: {value}"
            for value in fill_confirmation_blockers
        ],
    ]
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
        "predictionContract": REVIEW_PREDICTION_CONTRACT,
        "priceContractSchemaVersion":
            REVIEW_PRICE_CONTRACT_SCHEMA_VERSION,
        "labelContractVersion": REVIEW_LABEL_CONTRACT_VERSION,
        "exitPolicyVersion": REVIEW_EXIT_POLICY_VERSION,
        "riskProfileVersion": REVIEW_RISK_PROFILE_VERSION,
        "modelVersion": model_version,
        "observationPolicy": {
            "schemaVersion": REVIEW_OBSERVATION_POLICY_VERSION,
            "durationMs": REVIEW_OBSERVATION_DURATION_MS,
            "entryTiming": REVIEW_ENTRY_TIMING,
        },
        "ensembleSize": len(members),
        "ensembleMembers": [
            member["config"] for member in members
        ],
        "calibrationSampleCount": int(len(calibration)),
        "fillCalibrationSampleCount": int(len(fill_calibration)),
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
            "fillSplit": fill_split,
            "selectionMetrics": selection_metrics,
            "confirmationMetrics": confirmation_metrics,
            "blockers": blockers,
            "selectionStartDate": str(dataset["dates"][selection][0]),
            "selectionEndDate": str(dataset["dates"][selection][-1]),
            "confirmationStartDate":
                str(dataset["dates"][confirmation][0]),
            "confirmationEndDate":
                str(dataset["dates"][confirmation][-1]),
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
