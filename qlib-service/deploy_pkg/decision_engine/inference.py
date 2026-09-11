"""Inference orchestration for the modular decision engine."""

from __future__ import annotations

import numpy as np

from .contracts import (
    SCORE_SCHEMA_VERSION,
    not_ready_prediction,
    validate_score_request,
)
from .heads.common import model_prediction
from .heads.entry import (
    HEAD_VERSION as ENTRY_HEAD_VERSION,
    entry_value,
)
from .heads.execution import (
    HEAD_VERSION as EXECUTION_HEAD_VERSION,
    predict_fill,
)
from .heads.portfolio import (
    HEAD_VERSION as PORTFOLIO_HEAD_VERSION,
    blend_action_value,
    directional_action_value,
    predict_success,
)
from .heads.review import HEAD_VERSION as REVIEW_HEAD_VERSION
from .heads.position import (
    HEAD_VERSION as POSITION_HEAD_VERSION,
    position_values,
)
from .heads.risk import (
    HEAD_VERSION as RISK_HEAD_VERSION,
    expected_shortfall,
    legacy_lower_bound,
    predict_lower_bound,
)
from .heads.selection import (
    HEAD_VERSION as SELECTION_HEAD_VERSION,
    predict_ranking,
)
from .registry import (
    ENSEMBLE_PREDICTION_CONTRACT_VERSION,
    LEGACY_PREDICTION_CONTRACT_VERSION,
    PREDICTION_CONTRACT_VERSION,
    get_decision_models,
    validate_decision_metadata,
)
from .router import ROUTER_VERSION, route_items
from .state_encoder import (
    STATE_ENCODER_VERSION,
    encode_items,
    is_out_of_distribution,
)
from .training.evaluation import probability_calibration_bucket


HEAD_VERSIONS = {
    "selection": SELECTION_HEAD_VERSION,
    "entry": ENTRY_HEAD_VERSION,
    "portfolio": PORTFOLIO_HEAD_VERSION,
    "position": POSITION_HEAD_VERSION,
    "execution": EXECUTION_HEAD_VERSION,
    "risk": RISK_HEAD_VERSION,
    "review": REVIEW_HEAD_VERSION,
}


def ensemble_prediction_arrays(
    models,
    metadata,
    matrix,
    *,
    playbook_ids,
    routes,
):
    members = models.get("ensemble")
    configs = metadata.get("ensembleMembers")
    if (
        not isinstance(members, list)
        or not isinstance(configs, list)
        or len(members) != len(configs)
        or not members
    ):
        raise ValueError("决策模型集成成员不匹配")
    fill_values = []
    win_values = []
    action_values = []
    q10_values = []
    rank_values = []
    rank_percentiles = []
    for member, config in zip(members, configs):
        calibration = config["calibration"]
        p_fill = predict_fill(
            member["pFill"],
            matrix,
            calibration["pFill"],
        )
        p_win = predict_success(
            member["pWinGivenFill"],
            matrix,
            calibration["pWinGivenFill"],
            playbook_ids=playbook_ids,
            routes=routes,
        )
        action_values.append(
            directional_action_value(member, matrix, p_win)
        )
        q10_values.append(
            model_prediction(member["netRLower10"], matrix)
            + float(config.get("q10CalibrationOffset", 0.0))
        )
        ranking = predict_ranking(
            member["ranking"],
            matrix,
            config["rankingCalibration"],
            config["rankValueCalibration"],
        )
        fill_values.append(p_fill)
        win_values.append(p_win)
        rank_values.append(ranking["expected_net_r"])
        rank_percentiles.append(ranking["percentile"])
    action_value = np.mean(action_values, axis=0)
    rank_value = np.mean(rank_values, axis=0)
    expected_net_r = blend_action_value(
        action_value,
        rank_value,
        metadata.get("rankBlendWeight", 0.0),
    )
    return {
        "pFill": np.mean(fill_values, axis=0),
        "pWinGivenFill": np.mean(win_values, axis=0),
        "expectedNetR": expected_net_r,
        "netRLowerBound": np.minimum(
            np.mean(q10_values, axis=0),
            expected_net_r,
        ),
        "rankingScore": np.mean(rank_percentiles, axis=0),
    }


def _single_prediction_arrays(
    models,
    metadata,
    matrix,
    *,
    playbook_ids,
    routes,
):
    calibration = metadata["calibration"]
    p_fill = predict_fill(
        models["pFill"],
        matrix,
        calibration["pFill"],
    )
    p_win = predict_success(
        models["pWinGivenFill"],
        matrix,
        calibration["pWinGivenFill"],
        playbook_ids=playbook_ids,
        routes=routes,
    )
    prediction_contract = str(
        metadata.get("predictionContract")
        or LEGACY_PREDICTION_CONTRACT_VERSION
    )
    if prediction_contract == PREDICTION_CONTRACT_VERSION:
        action_value = directional_action_value(
            models,
            matrix,
            p_win,
        )
        ranking = predict_ranking(
            models["ranking"],
            matrix,
            metadata.get("rankingCalibration"),
            metadata.get("rankValueCalibration"),
        )
        expected_net_r = blend_action_value(
            action_value,
            ranking["expected_net_r"],
            metadata.get("rankBlendWeight", 0.0),
        )
        net_r_lower_bound = predict_lower_bound(
            models["netRLower10"],
            matrix,
            (metadata.get("risk") or {}).get(
                "q10CalibrationOffset",
                0.0,
            ),
            expected_net_r,
        )
        ranking_score = ranking["percentile"]
    else:
        expected_net_r = model_prediction(
            models["expectedNetR"],
            matrix,
        )
        net_r_lower_bound = legacy_lower_bound(
            expected_net_r,
            (metadata.get("risk") or {}).get(
                "netRResidualLower10",
                0.0,
            ),
        )
        ranking_score = np.full(len(matrix), np.nan)
    return {
        "pFill": p_fill,
        "pWinGivenFill": p_win,
        "expectedNetR": expected_net_r,
        "netRLowerBound": net_r_lower_bound,
        "rankingScore": ranking_score,
    }


def _prediction_arrays(
    models,
    metadata,
    matrix,
    *,
    playbook_ids,
    routes,
):
    contract = str(
        metadata.get("predictionContract")
        or LEGACY_PREDICTION_CONTRACT_VERSION
    )
    if contract == ENSEMBLE_PREDICTION_CONTRACT_VERSION:
        return ensemble_prediction_arrays(
            models,
            metadata,
            matrix,
            playbook_ids=playbook_ids,
            routes=routes,
        )
    return _single_prediction_arrays(
        models,
        metadata,
        matrix,
        playbook_ids=playbook_ids,
        routes=routes,
    )


def predict_decision_items(
    payload,
    *,
    models=None,
    metadata=None,
):
    items = validate_score_request(payload)
    if models is None or metadata is None:
        models, metadata = get_decision_models()
    if not models or metadata is None:
        return [
            not_ready_prediction(item, "MODEL_FILES_MISSING")
            for item in items
        ]
    try:
        metadata = validate_decision_metadata(metadata)
        feature_names = tuple(metadata["featureNames"])
        matrix = encode_items(items, feature_names)
        routed = route_items(items, feature_names)
        arrays = _prediction_arrays(
            models,
            metadata,
            matrix,
            playbook_ids=np.asarray(routed["playbook_ids"]),
            routes=np.asarray(routed["routes"]),
        )
    except Exception:
        return [
            not_ready_prediction(item, "MODEL_INVALID")
            for item in items
        ]

    calibration = metadata["calibration"]
    risk = expected_shortfall(metadata)
    calibration_samples = min(
        int(calibration.get("pFillSampleCount", 0)),
        int(calibration.get("pWinGivenFillSampleCount", 0)),
    )
    predictions = []
    for index, item in enumerate(items):
        contract = str(
            metadata.get("predictionContract")
            or LEGACY_PREDICTION_CONTRACT_VERSION
        )
        win_calibrator = calibration["pWinGivenFill"]
        if contract == ENSEMBLE_PREDICTION_CONTRACT_VERSION:
            win_calibrator = metadata["ensembleMembers"][0][
                "calibration"
            ]["pWinGivenFill"]
        win_bucket = probability_calibration_bucket(
            win_calibrator,
            routed["playbook_ids"][index],
            routed["routes"][index],
        )
        ranking_score = arrays["rankingScore"][index]
        expected_net_r = float(arrays["expectedNetR"][index])
        lower_bound_r = float(arrays["netRLowerBound"][index])
        p_fill = float(arrays["pFill"][index])
        p_success = float(arrays["pWinGivenFill"][index])
        position = position_values(
            expected_net_r,
            lower_bound_r,
            p_fill,
        )
        predictions.append({
            "schemaVersion": SCORE_SCHEMA_VERSION,
            "state": "READY",
            "reason": None,
            "modelVersion": metadata["modelVersion"],
            "asOf": item["asOf"],
            "code": item["code"],
            "formulaId": item["formulaId"],
            "pFill": round(p_fill, 6),
            "pWinGivenFill": round(
                p_success,
                6,
            ),
            "expectedNetR": round(expected_net_r, 6),
            "netRLowerBound": round(lower_bound_r, 6),
            "expectedShortfall10": round(risk, 6),
            "rankingScore": (
                round(float(ranking_score), 6)
                if np.isfinite(ranking_score)
                else None
            ),
            "calibration": {
                "method": (
                    f"{calibration['pFill']['method']}"
                    f"+{calibration['pWinGivenFill']['method']}"
                ),
                "sampleCount": calibration_samples,
                "bucket":
                    routed["calibration_buckets"][index],
                "pWinLevel": win_bucket["level"],
                "pWinBucket": win_bucket["key"],
                "pWinSampleCount": win_bucket["sampleCount"],
            },
            "usagePolicy": "DIRECT",
            "outOfDistribution": is_out_of_distribution(
                matrix[index],
                metadata,
            ),
            "shadowOnly": metadata.get("shadowOnly", True),
            "baselineSelected": metadata.get(
                "baselineSelected",
                False,
            ),
            "productionEligible": metadata.get(
                "productionEligible",
                False,
            ),
            "engine": {
                "stateEncoder": STATE_ENCODER_VERSION,
                "router": ROUTER_VERSION,
                "heads": HEAD_VERSIONS,
            },
            "taskValues": {
                "schemaVersion": "decision-task-values.v1",
                "selection": {
                    "rankingScore": (
                        round(float(ranking_score), 6)
                        if np.isfinite(ranking_score)
                        else None
                    ),
                    "expectedOpportunityR":
                        round(expected_net_r, 6),
                },
                "entry": {
                    "expectedNetR": round(
                        entry_value(p_fill, expected_net_r),
                        6,
                    ),
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
                "execution": {
                    "pFill": round(p_fill, 6),
                },
                "risk": {
                    "q10R": round(lower_bound_r, 6),
                    "cvarR": round(risk, 6),
                },
                "review": {
                    "recompute": True,
                    "source": "DETERMINISTIC_FALLBACK",
                },
            },
        })
    return predictions
