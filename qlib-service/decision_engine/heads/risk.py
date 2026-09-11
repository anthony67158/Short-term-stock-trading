"""Risk head: calibrated lower-tail estimates."""

from __future__ import annotations

import numpy as np

from .common import model_prediction


HEAD_VERSION = "risk-head.tree-v1"


def predict_lower_bound(model, matrix, offset, expected_net_r):
    lower = model_prediction(model, matrix) + float(offset or 0.0)
    return np.minimum(lower, expected_net_r)


def legacy_lower_bound(expected_net_r, residual_lower):
    return expected_net_r + float(residual_lower or 0.0)


def expected_shortfall(metadata):
    return float(
        ((metadata or {}).get("risk") or {}).get(
            "expectedShortfall10",
            0.0,
        )
    )
