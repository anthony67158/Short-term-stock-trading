"""Execution head: fill probability for a candidate price path."""

from __future__ import annotations

import numpy as np

from ..training.evaluation import apply_probability_calibrator
from .common import model_prediction


HEAD_VERSION = "execution-head.tree-v1"


def predict_fill(model, matrix, calibration):
    raw = np.clip(
        model_prediction(model, matrix),
        1e-8,
        1 - 1e-8,
    )
    return apply_probability_calibrator(raw, calibration)
