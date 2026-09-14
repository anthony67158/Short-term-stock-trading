"""Inference for trigger-review action values."""

from __future__ import annotations

import math

import numpy as np

from .contracts import SCORE_SCHEMA_VERSION, not_ready_prediction
from .heads.position import position_values
from .heads.review_contract import (
    FEATURE_NAMES,
    REVIEW_PATH_FEATURE_COUNT,
    feature_vector,
)
from .review_registry import (
    get_review_models,
    validate_review_metadata,
)
from .training.evaluation import apply_probability_calibrator


def _sigmoid(values):
    raw = np.asarray(values, dtype=np.float64)
    return 1.0 / (1.0 + np.exp(-np.clip(raw, -40, 40)))


def _validate_item(item):
    vector = feature_vector(item)
    formula_id = str(item.get("formulaId") or "TRIGGER_REVIEW")
    if not formula_id or len(formula_id) > 60:
        raise ValueError("触价复核公式无效")
    return {
        **item,
        "formulaId": formula_id,
        "vector": vector,
    }


def validate_review_request(payload):
    if not isinstance(payload, dict):
        raise ValueError("触价复核请求必须是对象")
    items = payload.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= 80:
        raise ValueError("触价复核items必须包含1到80项")
    return [_validate_item(item) for item in items]


def _prediction_arrays(models, metadata, matrix):
    members = models.get("ensemble")
    configs = metadata.get("ensembleMembers")
    if (
        not isinstance(members, list)
        or not isinstance(configs, list)
        or len(members) != len(configs)
        or not members
    ):
        raise ValueError("触价复核模型集成成员不匹配")
    probabilities = []
    fill_probabilities = []
    decomposed_values = []
    direct_values = []
    lower_values = []
    ranking_values = []
    for model_set, config in zip(members, configs):
        active_fill = np.asarray(
            config["activeFillFeatures"],
            dtype=np.int64,
        )
        active = np.asarray(config["activeFeatures"], dtype=np.int64)
        active_rank = np.asarray(
            config["activeRankFeatures"],
            dtype=np.int64,
        )
        fill_probability = apply_probability_calibrator(
            _sigmoid(
                model_set["pFill"].predict(matrix[:, active_fill])
            ),
            config["pFillCalibration"],
        )
        selected = matrix[:, active]
        raw_probability = _sigmoid(
            model_set["pWinGivenFill"].predict(selected)
        )
        probability = apply_probability_calibrator(
            raw_probability,
            config["pWinCalibration"],
        )
        win = np.maximum(
            0,
            model_set["winPayoffR"].predict(selected),
        )
        loss = np.minimum(
            0,
            model_set["lossPayoffR"].predict(selected),
        )
        expected = probability * win + (1 - probability) * loss
        direct = model_set["directNetR"].predict(selected)
        lower = (
            model_set["netRLower10"].predict(selected)
            + float(config.get("q10CalibrationOffset") or 0)
        )
        ranking = model_set["opportunityRanker"].predict(
            matrix[:, active_rank]
        )
        fill_probabilities.append(fill_probability)
        probabilities.append(probability)
        decomposed_values.append(expected)
        direct_values.append(direct)
        lower_values.append(lower)
        ranking_values.append(ranking)
    decomposed = np.mean(decomposed_values, axis=0)
    direct = np.mean(direct_values, axis=0)
    expected = (
        direct
        if metadata.get("valueHead") == "DIRECT"
        else decomposed
    )
    lower = (
        np.mean(lower_values, axis=0)
        + float(metadata["ensembleQ10CalibrationOffset"])
    )
    return {
        "pFill": np.mean(fill_probabilities, axis=0),
        "pWinGivenFill": np.mean(probabilities, axis=0),
        "expectedNetR": expected,
        "netRLowerBound": np.minimum(
            lower,
            expected,
        ),
        "rankingScore": _sigmoid(
            np.mean(ranking_values, axis=0)
        ),
    }


def _out_of_distribution(metadata, matrix):
    support = metadata["featureSupport"]
    lower = np.asarray(support["lower"], dtype=np.float64)
    upper = np.asarray(support["upper"], dtype=np.float64)
    outliers = (matrix < lower) | (matrix > upper)
    threshold = float(support["maximumOutlierFraction"])
    path_outside = np.mean(
        outliers[:, :REVIEW_PATH_FEATURE_COUNT],
        axis=1,
    ) > threshold
    initial_outside = np.mean(
        outliers[:, REVIEW_PATH_FEATURE_COUNT:],
        axis=1,
    ) > threshold
    outside = path_outside | initial_outside
    missing_indices = np.asarray(
        support["missingFeatureIndices"],
        dtype=np.int64,
    )
    supported_patterns = set(support["missingPatterns"])
    if len(missing_indices):
        patterns = [
            "".join(
                "1" if value >= 0.5 else "0"
                for value in row
            )
            for row in matrix[:, missing_indices]
        ]
        outside |= np.asarray([
            pattern not in supported_patterns
            for pattern in patterns
        ])
    return outside


def predict_review_items(payload, *, models=None, metadata=None):
    items = validate_review_request(payload)
    if models is None or metadata is None:
        models, metadata = get_review_models()
    if not models or metadata is None:
        return [
            not_ready_prediction(item, "REVIEW_MODEL_FILES_MISSING")
            for item in items
        ]
    try:
        metadata = validate_review_metadata(metadata)
        matrix = np.asarray(
            [item["vector"] for item in items],
            dtype=np.float64,
        )
        out_of_distribution = _out_of_distribution(metadata, matrix)
        arrays = _prediction_arrays(models, metadata, matrix)
    except Exception:
        return [
            not_ready_prediction(item, "REVIEW_MODEL_INVALID")
            for item in items
        ]

    direct = (
        metadata.get("productionEligible") is True
        and metadata.get("baselineSelected") is True
    )
    if not direct:
        return [
            not_ready_prediction(item, "REVIEW_MODEL_NOT_PROMOTED")
            for item in items
        ]
    expected_shortfall = float(
        (metadata.get("risk") or {}).get("expectedShortfall10", 0)
    )
    predictions = []
    selection_policy = metadata["selectionPolicy"]
    allowed_sector_phases = set(
        selection_policy["allowedSectorPhases"]
    )
    phase_indices = {
        phase: FEATURE_NAMES.index(f"initial_sector_{phase}")
        for phase in allowed_sector_phases
    }
    for index, item in enumerate(items):
        if out_of_distribution[index]:
            predictions.append({
                **not_ready_prediction(
                    item,
                    "REVIEW_MODEL_OUT_OF_DISTRIBUTION",
                ),
                "modelVersion": metadata["modelVersion"],
                "outOfDistribution": True,
            })
            continue
        expected = float(arrays["expectedNetR"][index])
        lower = float(arrays["netRLowerBound"][index])
        p_fill = float(arrays["pFill"][index])
        p_win = float(arrays["pWinGivenFill"][index])
        ranking_score = float(arrays["rankingScore"][index])
        if not all(math.isfinite(value) for value in (
            expected,
            lower,
            p_fill,
            p_win,
            ranking_score,
            expected_shortfall,
        )):
            predictions.append(
                not_ready_prediction(item, "REVIEW_MODEL_INVALID")
            )
            continue
        if (
            p_fill < selection_policy["minimumPFill"]
            or p_win
            < selection_policy["minimumPWinGivenFill"]
            or expected
            < selection_policy["minimumExpectedNetR"]
            or lower
            < selection_policy["minimumNetRLowerBound"]
            or (
                allowed_sector_phases
                and not any(
                    matrix[index, phase_indices[phase]] >= 0.5
                    for phase in allowed_sector_phases
                )
            )
        ):
            predictions.append({
                **not_ready_prediction(
                    item,
                    "REVIEW_MODEL_BELOW_SELECTION_POLICY",
                ),
                "modelVersion": metadata["modelVersion"],
            })
            continue
        expected_opportunity = p_fill * expected
        position = position_values(expected, lower, p_fill)
        predictions.append({
            "schemaVersion": SCORE_SCHEMA_VERSION,
            "state": "READY",
            "reason": None,
            "modelVersion": metadata["modelVersion"],
            "asOf": item["asOf"],
            "code": item["code"],
            "formulaId": item["formulaId"],
            "priceContractHash": item["priceContractHash"],
            "pFill": round(p_fill, 6),
            "pWinGivenFill": round(p_win, 6),
            "expectedNetR": round(expected, 6),
            "expectedNetRGivenFill": round(expected, 6),
            "expectedOpportunityR": round(expected_opportunity, 6),
            "netRLowerBound": round(lower, 6),
            "expectedShortfall10": round(expected_shortfall, 6),
            "rankingScore": round(ranking_score, 6),
            "calibration": {
                "method": "trigger-review-seed-ensemble",
                "sampleCount": int(
                    metadata.get("calibrationSampleCount") or 0
                ),
                "pFillSampleCount": int(
                    metadata.get("fillCalibrationSampleCount") or 0
                ),
                "bucket": "TRIGGER_REVIEW",
                "pWinLevel": "GLOBAL",
                "pWinBucket": "GLOBAL",
                "pWinSampleCount": int(
                    metadata.get("calibrationSampleCount") or 0
                ),
            },
            "usagePolicy": "DIRECT",
            "outOfDistribution": False,
            "shadowOnly": False,
            "baselineSelected": True,
            "productionEligible": True,
            "engine": {
                "stateEncoder": "trigger-review-feature-adapter.v1",
                "router": "trigger-review-router.v1",
                "heads": {
                    "selection": "review-action-value.v1",
                    "entry": "review-action-value.v1",
                    "portfolio": "review-action-value.v1",
                    "execution": "trigger-confirmed.v1",
                    "risk": "review-q10.v1",
                    "review": "review-head.catboost-ensemble-v1",
                },
            },
            "taskValues": {
                "schemaVersion": "decision-task-values.v1",
                "selection": {
                    "rankingScore": None,
                    "expectedOpportunityR":
                        round(expected_opportunity, 6),
                },
                "entry": {
                    "expectedNetR": round(expected, 6),
                    "expectedNetRGivenFill": round(expected, 6),
                    "expectedOpportunityR":
                        round(expected_opportunity, 6),
                    "pFill": round(p_fill, 6),
                },
                "portfolio": {
                    key: (
                        round(float(value), 6)
                        if isinstance(value, (int, float))
                        else value
                    )
                    for key, value in position.items()
                },
                "execution": {"pFill": round(p_fill, 6)},
                "risk": {
                    "q10R": round(lower, 6),
                    "cvarR": round(expected_shortfall, 6),
                },
                "review": {
                    "recompute": True,
                    "source": "TRIGGER_REVIEW_MODEL",
                },
            },
        })
    return predictions
