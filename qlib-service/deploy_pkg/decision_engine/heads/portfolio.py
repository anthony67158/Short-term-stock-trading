"""Portfolio heads: success probability and directional payoff value."""

from __future__ import annotations

import numpy as np

from ..training.evaluation import apply_probability_calibrator
from .common import model_prediction


HEAD_VERSION = "portfolio-heads.tree-v1"


def predict_success(
    model,
    matrix,
    calibration,
    *,
    playbook_ids,
    routes,
):
    raw = np.clip(
        model_prediction(model, matrix),
        1e-8,
        1 - 1e-8,
    )
    return apply_probability_calibrator(
        raw,
        calibration,
        playbook_ids=playbook_ids,
        routes=routes,
    )


def directional_action_value(
    models,
    matrix,
    success_probability,
):
    win_payoff = np.maximum(
        0,
        model_prediction(models["winPayoffR"], matrix),
    )
    loss_payoff = np.minimum(
        0,
        model_prediction(models["lossPayoffR"], matrix),
    )
    return (
        success_probability * win_payoff
        + (1 - success_probability) * loss_payoff
    )


def blend_action_value(action_value, rank_value, weight):
    bounded = max(0.0, min(1.0, float(weight or 0.0)))
    return (1 - bounded) * action_value + bounded * rank_value
