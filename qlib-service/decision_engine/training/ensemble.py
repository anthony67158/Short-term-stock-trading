"""Train and package the three-seed opportunity prediction ensemble."""

import argparse
import json
import os
import tempfile

import numpy as np

from ..contracts import FEATURE_SCHEMA_VERSION
from .evaluation import (
    apply_probability_calibrator,
    block_bootstrap_lower_bound,
    fit_probability_calibrator,
    fit_stratified_probability_calibrator,
    ranking_metrics,
    select_risk_adjusted_trial,
)
from ..registry import (
    ENSEMBLE_ARTIFACT_FILENAMES,
    ENSEMBLE_PREDICTION_CONTRACT_VERSION,
    validate_decision_metadata,
)
from ..heads.selection import empirical_percentile
from time_splits import three_way_purged_split
from .trainer import (
    MODEL_FILENAMES,
    _apply_rank_value_calibrator,
    _classifier_probabilities,
    _clip_labels,
    _conditional_indices,
    _fit_catboost_ranker,
    _fit_lgb_classifier,
    _fit_lgb_quantile_regressor,
    _fit_lgb_regressor,
    _fit_rank_value_calibrator,
    _training_weights,
    _write_report,
    load_decision_dataset,
    train_decision_model,
)


ARTIFACT_SCHEMA_VERSION = "opportunity-seed-ensemble-artifact.v1"
DEFAULT_SEEDS = (42, 7, 2026)


def compact_poc_report(value):
    combination = (value or {}).get("combination") or {}
    return {
        "schemaVersion": (value or {}).get("schemaVersion"),
        "seeds": (value or {}).get("seeds"),
        "aggregate": combination.get("aggregate"),
        "folds": [{
            "fold": fold.get("fold"),
            "validationStartDate": fold.get("validationStartDate"),
            "validationEndDate": fold.get("validationEndDate"),
            "positiveExpectedCoverage":
                fold.get("positiveExpectedCoverage"),
            "rankBlendWeight": fold.get("rankBlendWeight"),
            "meanNetRAt5":
                (fold.get("ranking") or {}).get("top5", {}).get(
                    "mean_net_r_at_5"
                ),
            "netRLowerBound":
                (fold.get("ranking") or {}).get("top5", {}).get(
                    "netRLowerBound"
                ),
        } for fold in combination.get("folds") or []],
        "pWinCalibrationComparison":
            (value or {}).get("pWinCalibrationComparison"),
        "decision": (value or {}).get("decision"),
    }


def _booster_string(model):
    booster = getattr(model, "booster_", model)
    if not hasattr(booster, "model_to_string"):
        raise ValueError("集成成员不是LightGBM模型")
    return booster.model_to_string()


def _catboost_payload(model):
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "ranker.json")
        model.save_model(path, format="json")
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)


def _member_predictions(
    member,
    X,
    *,
    playbook_ids=None,
    routes=None,
):
    p_fill = apply_probability_calibrator(
        _classifier_probabilities(member["models"]["pFill"], X),
        member["config"]["calibration"]["pFill"],
    )
    p_win = apply_probability_calibrator(
        _classifier_probabilities(
            member["models"]["pWinGivenFill"],
            X,
        ),
        member["config"]["calibration"]["pWinGivenFill"],
        playbook_ids=playbook_ids,
        routes=routes,
    )
    win_payoff = np.maximum(
        0,
        member["models"]["winPayoffR"].predict(X),
    )
    loss_payoff = np.minimum(
        0,
        member["models"]["lossPayoffR"].predict(X),
    )
    ranking_raw = np.asarray(
        member["models"]["ranking"].predict(X),
        dtype=np.float64,
    )
    return {
        "pFill": p_fill,
        "pWin": p_win,
        "actionValue":
            p_win * win_payoff + (1 - p_win) * loss_payoff,
        "q10": (
            member["models"]["netRLower10"].predict(X)
            + float(member["config"]["q10CalibrationOffset"])
        ),
        "rankValue": _apply_rank_value_calibrator(
            ranking_raw,
            member["config"]["rankValueCalibration"],
        ),
        "rankRaw": ranking_raw,
    }


def select_ensemble_blend(
    action_value,
    rank_value,
    rank_score,
    actual,
    dates,
    codes,
):
    trials = []
    for weight in (0.0, 0.25, 0.5, 0.75, 1.0):
        expected = (
            (1 - weight) * action_value
            + weight * rank_value
        )
        metrics = ranking_metrics(
            actual > 0,
            actual,
            rank_score,
            dates,
            top_k=5,
            group_ids=codes,
            eligible_mask=expected > 0,
        )
        trials.append({
            "weight": weight,
            "meanNetRAt5": metrics["mean_net_r_at_5"],
            "netRLowerBound": block_bootstrap_lower_bound(
                metrics["daily_net_r"],
                samples=2000,
                random_state=42,
            ),
            "maxDrawdownRAt5":
                metrics["max_drawdown_r_at_5"],
            "positiveExpectedCoverage":
                round(float(np.mean(expected > 0)), 6),
        })
    selected = select_risk_adjusted_trial(
        trials,
        minimum_coverage=0.02,
    )
    return selected["weight"], trials


def _fit_member(data, development, calibration, seed):
    filled_development = _conditional_indices(
        development,
        data["y_win"],
        data["y_net_r"],
    )
    filled_calibration = _conditional_indices(
        calibration,
        data["y_win"],
        data["y_net_r"],
    )
    win_labels = np.nan_to_num(data["y_win"], nan=0.0).astype(np.int8)
    fill_model = _fit_lgb_classifier(
        data["X"][development],
        data["y_fill"][development],
        sample_weight=_training_weights(
            data,
            development,
            data["y_fill"][development],
        ),
        random_state=seed,
    )
    win_model = _fit_lgb_classifier(
        data["X"][filled_development],
        win_labels[filled_development],
        sample_weight=_training_weights(
            data,
            filled_development,
            win_labels[filled_development],
        ),
        random_state=seed,
    )
    positive = filled_development[
        data["y_net_r"][filled_development] > 0
    ]
    negative = filled_development[
        data["y_net_r"][filled_development] <= 0
    ]
    positive_labels, _ = _clip_labels(data["y_net_r"][positive])
    negative_labels, _ = _clip_labels(data["y_net_r"][negative])
    q10_labels, _ = _clip_labels(
        data["y_net_r"][filled_development]
    )
    win_payoff = _fit_lgb_regressor(
        data["X"][positive],
        positive_labels,
        sample_weight=_training_weights(data, positive),
        random_state=seed,
    )
    loss_payoff = _fit_lgb_regressor(
        data["X"][negative],
        negative_labels,
        sample_weight=_training_weights(data, negative),
        random_state=seed,
    )
    q10 = _fit_lgb_quantile_regressor(
        data["X"][filled_development],
        q10_labels,
        sample_weight=_training_weights(data, filled_development),
        random_state=seed,
    )
    ranking, relevance = _fit_catboost_ranker(
        data,
        development,
        random_state=seed,
    )
    fill_calibration = fit_probability_calibrator(
        data["y_fill"][calibration],
        _classifier_probabilities(
            fill_model,
            data["X"][calibration],
        ),
    )
    win_calibration = fit_stratified_probability_calibrator(
        win_labels[filled_calibration],
        _classifier_probabilities(
            win_model,
            data["X"][filled_calibration],
        ),
        data["playbook_ids"][filled_calibration],
        data["routes"][filled_calibration],
        dates=data["dates"][filled_calibration],
    )
    rank_calibration_scores = np.asarray(
        ranking.predict(data["X"][calibration]),
        dtype=np.float64,
    )
    rank_filled_scores = np.asarray(
        ranking.predict(data["X"][filled_calibration]),
        dtype=np.float64,
    )
    rank_value_calibration = _fit_rank_value_calibrator(
        rank_filled_scores,
        data["y_net_r"][filled_calibration],
    )
    raw_q10 = np.asarray(
        q10.predict(data["X"][filled_calibration]),
        dtype=np.float64,
    )
    q10_offset = float(np.quantile(
        data["y_net_r"][filled_calibration] - raw_q10,
        0.1,
    ))
    config = {
        "seed": int(seed),
        "calibration": {
            "pFill": fill_calibration,
            "pWinGivenFill": win_calibration,
        },
        "rankingCalibration": {
            "method": "empirical-cdf",
            "sampleCount": int(len(rank_calibration_scores)),
            "scoreQuantiles": np.quantile(
                rank_calibration_scores,
                np.linspace(0.0, 1.0, 101),
            ).astype(float).tolist(),
        },
        "rankValueCalibration": rank_value_calibration,
        "q10CalibrationOffset": round(q10_offset, 6),
        "rankingRelevance": relevance,
    }
    return {
        "config": config,
        "models": {
            "pFill": fill_model,
            "pWinGivenFill": win_model,
            "winPayoffR": win_payoff,
            "lossPayoffR": loss_payoff,
            "netRLower10": q10,
            "ranking": ranking,
        },
    }


def train_decision_ensemble(
    dataset_path,
    output_directory,
    *,
    seeds=DEFAULT_SEEDS,
    poc_report_path=None,
):
    report = train_decision_model(dataset_path, output_directory)
    if not report.get("readiness", {}).get("ready"):
        return report
    data = load_decision_dataset(dataset_path)
    train, calibration, holdout, split = three_way_purged_split(
        data["dates"],
        calibration_fraction=0.15,
        holdout_fraction=0.15,
        purge_dates=5,
    )
    members = [
        _fit_member(data, train, calibration, seed)
        for seed in seeds
    ]
    predictions = [
        _member_predictions(
            member,
            data["X"][calibration],
            playbook_ids=data["playbook_ids"][calibration],
            routes=data["routes"][calibration],
        )
        for member in members
    ]
    action_value = np.mean([
        value["actionValue"] for value in predictions
    ], axis=0)
    rank_value = np.mean([
        value["rankValue"] for value in predictions
    ], axis=0)
    rank_score = np.mean([
        empirical_percentile(
            value["rankRaw"],
            member["config"]["rankingCalibration"],
        )
        for member, value in zip(members, predictions)
    ], axis=0)
    actual = np.nan_to_num(data["y_net_r"][calibration], nan=0.0)
    blend_weight, blend_trials = select_ensemble_blend(
        action_value,
        rank_value,
        rank_score,
        actual,
        data["dates"][calibration],
        data["codes"][calibration],
    )
    ensemble_expected = (
        (1 - blend_weight) * action_value
        + blend_weight * rank_value
    )
    q10_prediction = np.minimum(
        np.mean([value["q10"] for value in predictions], axis=0),
        ensemble_expected,
    )
    shadow = os.path.join(output_directory, "shadow")
    metadata_path = os.path.join(shadow, "opportunity_meta.json")
    with open(metadata_path, encoding="utf-8") as handle:
        metadata = json.load(handle)
    model_version = str(metadata["modelVersion"]) + ".ensemble3"
    artifact = {
        "schemaVersion": ARTIFACT_SCHEMA_VERSION,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "members": [{
            "seed": member["config"]["seed"],
            "models": {
                "pFill": _booster_string(
                    member["models"]["pFill"]
                ),
                "pWinGivenFill": _booster_string(
                    member["models"]["pWinGivenFill"]
                ),
                "winPayoffR": _booster_string(
                    member["models"]["winPayoffR"]
                ),
                "lossPayoffR": _booster_string(
                    member["models"]["lossPayoffR"]
                ),
                "netRLower10": _booster_string(
                    member["models"]["netRLower10"]
                ),
                "ranking": _catboost_payload(
                    member["models"]["ranking"]
                ),
            },
        } for member in members],
    }
    artifact_path = os.path.join(
        shadow,
        ENSEMBLE_ARTIFACT_FILENAMES["ensemble"],
    )
    _write_report(artifact_path, artifact)
    poc_report = {}
    if poc_report_path and os.path.isfile(poc_report_path):
        with open(poc_report_path, encoding="utf-8") as handle:
            poc_report = json.load(handle)
    metadata.update({
        "modelVersion": model_version,
        "predictionContract":
            ENSEMBLE_PREDICTION_CONTRACT_VERSION,
        "modelHeads": ["ensemble"],
        "ensembleSize": len(members),
        "ensembleMembers": [
            member["config"]
            for member in members
        ],
        "rankBlendWeight": blend_weight,
        "rankBlendTrials": blend_trials,
        "calibration": {
            "pFill": {"method": "seed-ensemble"},
            "pWinGivenFill": {"method": "seed-ensemble"},
            "pFillSampleCount": int(len(calibration)),
            "pWinGivenFillSampleCount": int(
                np.isfinite(data["y_net_r"][calibration]).sum()
            ),
        },
        "ensembleValidation": {
            "schemaVersion": "ensemble-validation.v2",
            "calibrationHoldoutSeparated": True,
            "walkForwardPassed": (
                report.get("walkForward", {}).get("shadowEligible") is True
                and report.get("walkForward", {}).get("folds", 0) >= 3
            ),
            "trainingEndDate": str(data["dates"][train][-1]),
            "calibrationEndDate": str(data["dates"][calibration][-1]),
            "holdoutStartDate": str(data["dates"][holdout][0]),
            "split": split,
        },
        "seedEnsemblePoc": compact_poc_report(poc_report),
    })
    filled_calibration = np.isfinite(data["y_net_r"][calibration])
    metadata["risk"] = {
        **(metadata.get("risk") or {}),
        "q10Coverage": round(float(np.mean(
            data["y_net_r"][calibration][filled_calibration]
            >= q10_prediction[filled_calibration]
        )), 6),
    }
    validate_decision_metadata(metadata)
    _write_report(metadata_path, metadata)
    for filename in MODEL_FILENAMES.values():
        try:
            os.remove(os.path.join(shadow, filename))
        except FileNotFoundError:
            pass
    report.update({
        "modelVersion": model_version,
        "seedEnsemble": metadata["seedEnsemblePoc"],
    })
    _write_report(
        os.path.join(
            output_directory,
            "opportunity_training_report.json",
        ),
        report,
    )
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--seeds", default="42,7,2026")
    parser.add_argument("--poc-report")
    args = parser.parse_args()
    report = train_decision_ensemble(
        args.dataset,
        args.output,
        seeds=tuple(
            int(value)
            for value in args.seeds.split(",")
            if value.strip()
        ),
        poc_report_path=args.poc_report,
    )
    print(json.dumps({
        "modelVersion": report.get("modelVersion"),
        "state": report["state"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
