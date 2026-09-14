"""Train and package the trigger-review CatBoost seed ensemble."""

from __future__ import annotations

import argparse
import hashlib
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
from ..heads.review_contract_v4 import (
    FEATURE_NAMES_V4,
    FEATURE_SCHEMA_VERSION_V4,
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
    relevance_labels,
)
from .evaluation import (
    apply_probability_calibrator,
    binary_metrics,
    block_bootstrap_lower_bound,
    fit_probability_calibrator,
    ranking_metrics,
    regression_metrics,
)
from .review_bakeoff import load_dataset
from time_splits import four_way_interval_split


DEFAULT_SEEDS = (42, 7, 2026)
POLICY_RANKING_MODES = ("VALUE", "RANKER")
POLICY_MINIMUM_P_WIN = (0.4, 0.45, 0.5, 0.55)
POLICY_MINIMUM_EXPECTED_R = (-0.1, 0.0, 0.05)
POLICY_MINIMUM_LOWER_R = (-2.0, -1.0, -0.5, 0.0)
POLICY_MINIMUM_P_FILL = (0.0, 0.2, 0.5)
POLICY_SECTOR_PHASES = (
    (),
    ("ACCUMULATION",),
    ("STARTUP",),
    ("ACCUMULATION", "STARTUP"),
)
MISSING_FEATURE_INDICES = tuple(
    index
    for index, name in enumerate(FEATURE_NAMES)
    if name.endswith("Missing")
)
# v3 生产默认；v4 仅在显式启用 Alpha158 连续特征的挑战者训练中选用。
# 训练/发布默认保持 v3，绝不改动线上口径。
REVIEW_FEATURE_SCHEMAS = {
    "v3": (FEATURE_SCHEMA_VERSION, FEATURE_NAMES),
    "v4": (FEATURE_SCHEMA_VERSION_V4, FEATURE_NAMES_V4),
}


def _resolve_feature_schema(feature_schema):
    if feature_schema not in REVIEW_FEATURE_SCHEMAS:
        raise ValueError("触价复核训练特征合同仅支持 v3 或 v4")
    schema_version, feature_names = REVIEW_FEATURE_SCHEMAS[feature_schema]
    missing_indices = tuple(
        index
        for index, name in enumerate(feature_names)
        if name.endswith("Missing")
    )
    return schema_version, feature_names, missing_indices


def _opportunity_rank_training_data(
    dataset,
    indices,
    labels,
    feature_mask,
):
    dates = dataset["dates_opportunity"][indices].astype(str)
    codes = dataset["codes_opportunity"][indices].astype(str)
    order = np.lexsort((codes, dates))
    selected = indices[order]
    sorted_dates = dates[order]
    _, group_ids, group_sizes = np.unique(
        sorted_dates,
        return_inverse=True,
        return_counts=True,
    )
    return {
        "X": dataset["X_opportunity"][selected][:, feature_mask],
        "y": labels[order],
        "qid": group_ids.astype(np.int32),
        "group": group_sizes.astype(np.int32),
    }


def _catboost_payload(model):
    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, "model.json")
        model.save_model(path, format="json")
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)


def _feature_support(
    matrix,
    feature_names=FEATURE_NAMES,
    missing_indices=MISSING_FEATURE_INDICES,
):
    values = np.asarray(matrix, dtype=np.float64)
    if (
        values.ndim != 2
        or values.shape[1] != len(feature_names)
        or not len(values)
        or not np.isfinite(values).all()
    ):
        raise ValueError("触价复核特征支持样本无效")
    missing = values[:, missing_indices]
    patterns = sorted({
        "".join("1" if value >= 0.5 else "0" for value in row)
        for row in missing
    })
    return {
        "schemaVersion": "review-feature-support.v1",
        "lower": np.quantile(values, 0.005, axis=0).tolist(),
        "upper": np.quantile(values, 0.995, axis=0).tolist(),
        "missingFeatureIndices": list(missing_indices),
        "missingPatterns": patterns,
        "maximumOutlierFraction": 0.2,
    }


def _partition_data_hash(
    dataset,
    conditional_indices,
    fill_indices,
):
    digest = hashlib.sha256()
    for prefix, indices, suffix in (
        ("conditional", conditional_indices, ""),
        ("fill", fill_indices, "_all"),
    ):
        digest.update(prefix.encode("ascii"))
        selected = np.asarray(indices, dtype=np.int64)
        for field in (
            f"dates{suffix}",
            f"codes{suffix}",
            f"event_group_ids{suffix}",
        ):
            for value in np.asarray(dataset[field])[selected].astype(str):
                encoded = value.encode("utf-8")
                digest.update(len(encoded).to_bytes(4, "big"))
                digest.update(encoded)
        for field in (
            f"label_start_ms{suffix}",
            f"label_end_ms{suffix}",
        ):
            values = np.asarray(
                dataset[field],
                dtype="<i8",
            )[selected]
            digest.update(values.tobytes())
        matrix_field = "X_all" if suffix else "X"
        digest.update(np.asarray(
            dataset[matrix_field][selected],
            dtype="<f4",
        ).tobytes())
        labels = (
            ("y_fill",)
            if suffix
            else ("y_win", "y_net_r")
        )
        for field in labels:
            values = np.asarray(dataset[field])[selected]
            digest.update(values.tobytes())
    return digest.hexdigest()


def _candidate_hash(
    artifact,
    value_head,
    selection_policy,
    ensemble_q10_offset,
):
    payload = json.dumps(
        {
            "artifact": artifact,
            "valueHead": value_head,
            "selectionPolicy": selection_policy,
            "ensembleQ10Offset": ensemble_q10_offset,
        },
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _fit_member(
    dataset,
    development,
    calibration,
    fill_development,
    fill_calibration,
    opportunity_development,
    seed,
    estimators,
    threads,
):
    mask = active_feature_mask(dataset["X"][development])
    fill_mask = active_feature_mask(
        dataset["X_all"][fill_development]
    )
    rank_mask = active_feature_mask(
        dataset["X_opportunity"][opportunity_development]
    )
    active = np.flatnonzero(mask)
    active_fill = np.flatnonzero(fill_mask)
    active_rank = np.flatnonzero(rank_mask)
    if (
        not len(active)
        or not len(active_fill)
        or not len(active_rank)
    ):
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
    direct_net_r = family.regressor()
    direct_labels, _ = clip_labels(dataset["y_net_r"][development])
    direct_net_r.fit(X_development, direct_labels)
    quantile = family.quantile()
    quantile_labels, _ = clip_labels(
        dataset["y_net_r"][development]
    )
    quantile.fit(X_development, quantile_labels)
    rank_labels, _ = relevance_labels(
        dataset["y_opportunity_r"][opportunity_development]
    )
    rank_data = _opportunity_rank_training_data(
        dataset,
        opportunity_development,
        rank_labels,
        rank_mask,
    )
    ranker = family.ranker()
    family.fit_ranker(ranker, rank_data)

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
            "activeRankFeatures": active_rank.astype(int).tolist(),
            "pFillCalibration": fill_calibration_artifact,
            "pWinCalibration": calibration_artifact,
            "q10CalibrationOffset": round(q10_offset, 6),
        },
        "models": {
            "pFill": fill_model,
            "pWinGivenFill": win_model,
            "winPayoffR": win_payoff,
            "lossPayoffR": loss_payoff,
            "directNetR": direct_net_r,
            "netRLower10": quantile,
            "opportunityRanker": ranker,
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
    active_rank = np.asarray(
        member["config"]["activeRankFeatures"],
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
    direct = np.asarray(
        member["models"]["directNetR"].predict(selected),
        dtype=np.float64,
    )
    q10 = (
        member["models"]["netRLower10"].predict(selected)
        + float(member["config"]["q10CalibrationOffset"])
    )
    ranking = np.asarray(
        member["models"]["opportunityRanker"].predict(
            matrix[:, active_rank]
        ),
        dtype=np.float64,
    )
    return {
        "pFill": p_fill,
        "pWinGivenFill": p_win,
        "expectedNetR": expected,
        "decomposedExpectedNetR": expected,
        "directExpectedNetR": direct,
        "netRLower10": q10,
        "netRLowerBound": np.minimum(q10, expected),
        "rankingScoreRaw": ranking,
    }


def _value_head_predictions(
    predictions,
    value_head,
    q10_offset=0.0,
):
    key = {
        "DECOMPOSED": "decomposedExpectedNetR",
        "DIRECT": "directExpectedNetR",
    }.get(value_head)
    if key is None:
        raise ValueError("触价复核价值头无效")
    output = []
    for value in predictions:
        expected = np.asarray(value[key], dtype=np.float64)
        calibrated_q10 = (
            np.asarray(value["netRLower10"], dtype=np.float64)
            + float(q10_offset)
        )
        output.append({
            **value,
            "expectedNetR": expected,
            "netRLower10": calibrated_q10,
            "netRLowerBound": np.minimum(
                calibrated_q10,
                expected,
            ),
        })
    return output


def _ensemble_q10_offset(dataset, calibration, predictions):
    raw = np.mean([
        value["netRLower10"] for value in predictions
    ], axis=0)
    return round(float(np.quantile(
        dataset["y_net_r"][calibration] - raw,
        0.1,
    )), 6)


def _policy_metrics(dataset, holdout, predictions, policy):
    p_fill = np.mean([
        value["pFill"] for value in predictions
    ], axis=0)
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
    ranking_score = np.mean([
        value["rankingScoreRaw"] for value in predictions
    ], axis=0)
    opportunity_value = p_fill * (
        0.75 * expected + 0.25 * lower
    )
    score = (
        ranking_score
        if policy["rankingMode"] == "RANKER"
        else opportunity_value
    )
    eligible = (
        (p_fill >= policy["minimumPFill"])
        & (p_win >= policy["minimumPWinGivenFill"])
        & (expected >= policy["minimumExpectedNetR"])
        & (lower >= policy["minimumNetRLowerBound"])
    )
    allowed_phases = tuple(policy.get("allowedSectorPhases") or ())
    if allowed_phases:
        eligible &= np.isin(
            dataset["sector_phases_opportunity"][holdout],
            allowed_phases,
        )
    ranking = ranking_metrics(
        dataset["y_opportunity_r"][holdout] > 0,
        dataset["y_opportunity_r"][holdout],
        score,
        dataset["dates_opportunity"][holdout],
        top_k=5,
        group_ids=dataset["codes_opportunity"][holdout],
        eligible_mask=eligible,
    )
    stress_values = np.asarray(
        dataset.get(
            "y_opportunity_r_stress10",
            dataset["y_opportunity_r"],
        ),
        dtype=np.float64,
    )
    stress_available = np.asarray(
        dataset.get(
            "stress10_available_opportunity",
            np.ones(len(stress_values), dtype=np.int8),
        ),
        dtype=np.int8,
    )
    stress_coverage = float(np.mean(stress_available[holdout] == 1))
    stress_ranking = (
        ranking_metrics(
            stress_values[holdout] > 0,
            stress_values[holdout],
            score,
            dataset["dates_opportunity"][holdout],
            top_k=5,
            group_ids=dataset["codes_opportunity"][holdout],
            eligible_mask=eligible,
        )
        if stress_coverage >= 1.0
        else None
    )
    return {
        "samples": int(len(holdout)),
        "selected": ranking["selected"],
        "activeDays": ranking["active_days"],
        "precisionAt5": ranking["precision_at_5"],
        "meanNetRAt5": ranking["mean_net_r_at_5"],
        "netRLowerBound95": block_bootstrap_lower_bound(
            ranking["daily_net_r"],
            samples=5000,
            random_state=42,
        ),
        "maximumDrawdownRAt5": ranking["max_drawdown_r_at_5"],
        "worstDailyNetRAt5": ranking["worst_daily_net_r_at_5"],
        "stress10Coverage": round(stress_coverage, 6),
        "stress10MeanNetRAt5": (
            stress_ranking["mean_net_r_at_5"]
            if stress_ranking else None
        ),
        "stress10NetRLowerBound95": (
            block_bootstrap_lower_bound(
                stress_ranking["daily_net_r"],
                samples=5000,
                random_state=42,
            )
            if stress_ranking else None
        ),
        "accountDrawdownPctAtRisk07Top5": round(
            float(ranking["max_drawdown_r_at_5"]) * 3.5,
            6,
        ),
    }


def _select_opportunity_policy(
    dataset,
    holdout,
    predictions_by_head,
):
    candidates = []
    for value_head, predictions in predictions_by_head.items():
        for ranking_mode in POLICY_RANKING_MODES:
            for minimum_p_win in POLICY_MINIMUM_P_WIN:
                for minimum_expected in POLICY_MINIMUM_EXPECTED_R:
                    for minimum_lower in POLICY_MINIMUM_LOWER_R:
                        for minimum_p_fill in POLICY_MINIMUM_P_FILL:
                            for phases in POLICY_SECTOR_PHASES:
                                policy = {
                                    "schemaVersion":
                                        "review-selection-policy.v1",
                                    "valueHead": value_head,
                                    "rankingMode": ranking_mode,
                                    "minimumPFill": minimum_p_fill,
                                    "minimumPWinGivenFill":
                                        minimum_p_win,
                                    "minimumExpectedNetR":
                                        minimum_expected,
                                    "minimumNetRLowerBound":
                                        minimum_lower,
                                    "allowedSectorPhases":
                                        list(phases),
                                }
                                metrics = _policy_metrics(
                                    dataset,
                                    holdout,
                                    predictions,
                                    policy,
                                )
                                candidates.append({
                                    "policy": policy,
                                    "metrics": metrics,
                                })
    eligible = [
        value for value in candidates
        if (
            value["metrics"]["selected"] >= 5
            and value["metrics"]["activeDays"] >= 5
        )
    ]
    pool = eligible or candidates
    def policy_score(value):
        policy = value["policy"]
        metrics = value["metrics"]
        return (
            policy["minimumNetRLowerBound"],
            metrics["netRLowerBound95"],
            metrics["meanNetRAt5"],
            policy["rankingMode"] == "RANKER",
            metrics["precisionAt5"],
            metrics["selected"],
        )

    selected = max(
        pool,
        key=policy_score,
    )
    leaders = sorted(
        candidates,
        key=policy_score,
        reverse=True,
    )[:10]
    return selected, leaders


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
    feature_schema="v3",
):
    schema_version, feature_names, missing_indices = _resolve_feature_schema(
        feature_schema,
    )
    dataset = load_dataset(input_path, feature_schema=feature_schema)
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
    (
        opportunity_development,
        _opportunity_calibration,
        opportunity_selection,
        opportunity_confirmation,
        opportunity_split,
    ) = four_way_interval_split(
        dataset["dates_opportunity"],
        dataset["label_start_ms_opportunity"],
        dataset["label_end_ms_opportunity"],
        dataset["event_group_ids_opportunity"],
        calibration_fraction=0.15,
        selection_fraction=0.15,
        confirmation_fraction=0.15,
        embargo_dates=5,
    )
    selection_members = [
        _fit_member(
            dataset,
            development,
            calibration,
            fill_development,
            fill_calibration,
            opportunity_development,
            seed,
            estimators,
            threads,
        )
        for seed in seeds
    ]
    calibration_predictions = [
        _member_predictions(
            member,
            dataset["X"][calibration],
        )
        for member in selection_members
    ]
    selection_q10_offset = _ensemble_q10_offset(
        dataset,
        calibration,
        calibration_predictions,
    )
    selection_predictions = [
        _member_predictions(member, dataset["X"][selection])
        for member in selection_members
    ]
    value_candidates = {}
    value_predictions = {}
    for value_head in ("DECOMPOSED", "DIRECT"):
        selected_predictions = _value_head_predictions(
            selection_predictions,
            value_head,
            selection_q10_offset,
        )
        metrics, candidate_blockers = _evaluate(
            dataset,
            development,
            selection,
            selected_predictions,
        )
        value_candidates[value_head] = {
            "metrics": metrics,
            "blockers": candidate_blockers,
        }
        opportunity_predictions = [
            _member_predictions(
                member,
                dataset["X_opportunity"][
                    opportunity_selection
                ],
            )
            for member in selection_members
        ]
        value_predictions[value_head] = _value_head_predictions(
            opportunity_predictions,
            value_head,
            selection_q10_offset,
        )
    selected_policy, policy_leaders = _select_opportunity_policy(
        dataset,
        opportunity_selection,
        value_predictions,
    )
    selected_value_head = selected_policy["policy"]["valueHead"]
    selection_metrics = {
        "selectedValueHead": selected_value_head,
        "candidates": value_candidates,
        "opportunityPolicy": selected_policy,
        "opportunityPolicyLeaders": policy_leaders,
    }
    selection_quality_notes = value_candidates[
        selected_value_head
    ]["blockers"]
    fill_selection_predictions = [
        _member_predictions(member, dataset["X_all"][fill_selection])
        for member in selection_members
    ]
    fill_selection_metrics, fill_selection_quality_notes = _evaluate_fill(
        dataset,
        fill_development,
        fill_selection,
        fill_selection_predictions,
    )
    selection_metrics.update(fill_selection_metrics)

    # The selection policy is now frozen. Refit the final candidate with the
    # selection labels included, while preserving the independent calibration
    # partition and untouched confirmation partition.
    final_development = np.sort(np.concatenate([
        development,
        selection,
    ]))
    final_fill_development = np.sort(np.concatenate([
        fill_development,
        fill_selection,
    ]))
    final_opportunity_development = np.sort(np.concatenate([
        opportunity_development,
        opportunity_selection,
    ]))
    members = [
        _fit_member(
            dataset,
            final_development,
            calibration,
            final_fill_development,
            fill_calibration,
            final_opportunity_development,
            seed,
            estimators,
            threads,
        )
        for seed in seeds
    ]
    final_calibration_predictions = [
        _member_predictions(
            member,
            dataset["X"][calibration],
        )
        for member in members
    ]
    ensemble_q10_offset = _ensemble_q10_offset(
        dataset,
        calibration,
        final_calibration_predictions,
    )
    confirmation_predictions = [
        _member_predictions(member, dataset["X"][confirmation])
        for member in members
    ]
    confirmation_metrics, confirmation_quality_notes = _evaluate(
        dataset,
        development,
        confirmation,
        _value_head_predictions(
            confirmation_predictions,
            selected_value_head,
            ensemble_q10_offset,
        ),
    )
    fill_confirmation_predictions = [
        _member_predictions(member, dataset["X_all"][fill_confirmation])
        for member in members
    ]
    (
        fill_confirmation_metrics,
        fill_confirmation_quality_notes,
    ) = _evaluate_fill(
        dataset,
        fill_development,
        fill_confirmation,
        fill_confirmation_predictions,
    )
    confirmation_metrics.update(fill_confirmation_metrics)
    opportunity_confirmation_predictions = [
        _member_predictions(
            member,
            dataset["X_opportunity"][
                opportunity_confirmation
            ],
        )
        for member in members
    ]
    opportunity_confirmation_metrics = _policy_metrics(
        dataset,
        opportunity_confirmation,
        _value_head_predictions(
            opportunity_confirmation_predictions,
            selected_value_head,
            ensemble_q10_offset,
        ),
        selected_policy["policy"],
    )
    confirmation_metrics["opportunityPolicy"] = {
        "policy": selected_policy["policy"],
        "metrics": opportunity_confirmation_metrics,
    }
    def policy_blockers(metrics):
        values = []
        if metrics["netRLowerBound95"] <= 0:
            values.append("机会Top5净R下界未转正")
        if feature_schema == "v4":
            if metrics.get("stress10Coverage") != 1.0:
                values.append("10bps压力标签覆盖不足100%")
            if (
                metrics.get("stress10NetRLowerBound95") is None
                or metrics["stress10NetRLowerBound95"] <= 0
            ):
                values.append("10bps压力净R下界未转正")
            if (
                metrics.get("accountDrawdownPctAtRisk07Top5") is None
                or metrics["accountDrawdownPctAtRisk07Top5"] > 10
            ):
                values.append("按单笔0.7%风险映射的账户回撤超过10%")
        return values

    selection_policy_blockers = policy_blockers(
        selected_policy["metrics"]
    )
    confirmation_policy_blockers = policy_blockers(
        opportunity_confirmation_metrics
    )
    blockers = [
        *[
            f"候选选择段: {value}"
            for value in selection_policy_blockers
        ],
        *[
            f"最终确认段: {value}"
            for value in confirmation_policy_blockers
        ],
    ]
    model_version = (
        f"decision-review.{int(time.time())}.ensemble{len(members)}"
    )
    actual = dataset["y_net_r"][final_development]
    expected_shortfall = float(np.mean(
        actual[actual <= np.quantile(actual, 0.1)]
    ))
    artifact = {
        "schemaVersion": REVIEW_ARTIFACT_SCHEMA_VERSION,
        "featureSchemaVersion": schema_version,
        "members": [{
            "seed": member["config"]["seed"],
            "models": {
                name: _catboost_payload(model)
                for name, model in member["models"].items()
            },
        } for member in members],
    }
    metadata = {
        "schemaVersion": REVIEW_MODEL_SCHEMA_VERSION,
        "featureSchemaVersion": schema_version,
        "featureNames": list(feature_names),
        "predictionContract": REVIEW_PREDICTION_CONTRACT,
        "priceContractSchemaVersion":
            REVIEW_PRICE_CONTRACT_SCHEMA_VERSION,
        "labelContractVersion": REVIEW_LABEL_CONTRACT_VERSION,
        "exitPolicyVersion": REVIEW_EXIT_POLICY_VERSION,
        "riskProfileVersion": REVIEW_RISK_PROFILE_VERSION,
        "modelVersion": model_version,
        "valueHead": selected_value_head,
        "confirmationAudit": {
            "schemaVersion": "review-confirmation-audit.v1",
            "selectionDataHash": _partition_data_hash(
                dataset,
                selection,
                fill_selection,
            ),
            "candidateHash": _candidate_hash(
                artifact,
                selected_value_head,
                selected_policy["policy"],
                ensemble_q10_offset,
            ),
            "confirmationDataHash": _partition_data_hash(
                dataset,
                confirmation,
                fill_confirmation,
            ),
            "reusePolicy": "SINGLE_SELECTION",
        },
        "observationPolicy": {
            "schemaVersion": REVIEW_OBSERVATION_POLICY_VERSION,
            "durationMs": REVIEW_OBSERVATION_DURATION_MS,
            "entryTiming": REVIEW_ENTRY_TIMING,
        },
        "ensembleSize": len(members),
        "ensembleMembers": [
            member["config"] for member in members
        ],
        "ensembleQ10CalibrationOffset": ensemble_q10_offset,
        "selectionPolicy": selected_policy["policy"],
        "calibrationSampleCount": int(len(calibration)),
        "fillCalibrationSampleCount": int(len(fill_calibration)),
        "featureSupport": _feature_support(
            dataset["X_all"][final_fill_development],
            feature_names,
            missing_indices,
        ),
        "productionEligible": not blockers,
        "baselineSelected": False,
        "rankingPolicy": {
            "schemaVersion": "review-ranking.v2",
            "mode": selected_policy["policy"]["rankingMode"],
            "opportunityValue": "pFill*(0.75*expectedNetR+0.25*q10R)",
            "eligibility": "selectionPolicy",
        },
        "risk": {
            "expectedShortfall10": round(expected_shortfall, 6),
        },
        "validation": {
            "split": split,
            "fillSplit": fill_split,
            "opportunitySplit": opportunity_split,
            "selectionMetrics": selection_metrics,
            "confirmationMetrics": confirmation_metrics,
            "qualityNotes": {
                "selection": [
                    *selection_quality_notes,
                    *fill_selection_quality_notes,
                ],
                "confirmation": [
                    *confirmation_quality_notes,
                    *fill_confirmation_quality_notes,
                ],
            },
            "blockers": blockers,
            "selectionStartDate": str(dataset["dates"][selection][0]),
            "selectionEndDate": str(dataset["dates"][selection][-1]),
            "confirmationStartDate":
                str(dataset["dates"][confirmation][0]),
            "confirmationEndDate":
                str(dataset["dates"][confirmation][-1]),
        },
    }
    validate_review_metadata(
        metadata,
        feature_schema=schema_version,
    )
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
    parser.add_argument(
        "--feature-schema",
        default="v3",
        choices=("v3", "v4"),
        help="特征合同：v3(生产默认) 或 v4(Alpha158 连续特征挑战者)",
    )
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
        feature_schema=args.feature_schema,
    )
    print(json.dumps({
        "modelVersion": metadata["modelVersion"],
        "featureSchemaVersion": metadata["featureSchemaVersion"],
        "productionEligible": metadata["productionEligible"],
        "blockers": metadata["validation"]["blockers"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
