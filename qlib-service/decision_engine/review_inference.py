"""Inference for trigger-review action values."""

from __future__ import annotations

import math

import numpy as np

from .contracts import SCORE_SCHEMA_VERSION, not_ready_prediction
from .heads.position import position_values
from .heads.review_contract import feature_vector
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
    expected_values = []
    lower_values = []
    for model_set, config in zip(members, configs):
        active = np.asarray(config["activeFeatures"], dtype=np.int64)
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
        lower = (
            model_set["netRLower10"].predict(selected)
            + float(config.get("q10CalibrationOffset") or 0)
        )
        probabilities.append(probability)
        expected_values.append(expected)
        lower_values.append(lower)
    expected = np.mean(expected_values, axis=0)
    return {
        "pWinGivenFill": np.mean(probabilities, axis=0),
        "expectedNetR": expected,
        "netRLowerBound": np.minimum(
            np.mean(lower_values, axis=0),
            expected,
        ),
    }


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
    for index, item in enumerate(items):
        expected = float(arrays["expectedNetR"][index])
        lower = float(arrays["netRLowerBound"][index])
        p_win = float(arrays["pWinGivenFill"][index])
        if not all(math.isfinite(value) for value in (
            expected,
            lower,
            p_win,
            expected_shortfall,
        )):
            predictions.append(
                not_ready_prediction(item, "REVIEW_MODEL_INVALID")
            )
            continue
        position = position_values(expected, lower, 1.0)
        predictions.append({
            "schemaVersion": SCORE_SCHEMA_VERSION,
            "state": "READY",
            "reason": None,
            "modelVersion": metadata["modelVersion"],
            "asOf": item["asOf"],
            "code": item["code"],
            "formulaId": item["formulaId"],
            "pFill": 1.0,
            "pWinGivenFill": round(p_win, 6),
            "expectedNetR": round(expected, 6),
            "netRLowerBound": round(lower, 6),
            "expectedShortfall10": round(expected_shortfall, 6),
            "rankingScore": None,
            "calibration": {
                "method": "trigger-review-seed-ensemble",
                "sampleCount": int(
                    metadata.get("calibrationSampleCount") or 0
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
                    "expectedOpportunityR": round(expected, 6),
                },
                "entry": {
                    "expectedNetR": round(expected, 6),
                    "pFill": 1.0,
                },
                "portfolio": {
                    key: (
                        round(float(value), 6)
                        if isinstance(value, (int, float))
                        else value
                    )
                    for key, value in position.items()
                },
                "execution": {"pFill": 1.0},
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
