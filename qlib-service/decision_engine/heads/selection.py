"""Selection head: calibrated cross-sectional ranking value."""

from __future__ import annotations

import numpy as np

from .common import model_prediction


HEAD_VERSION = "selection-head.tree-v1"


def empirical_percentile(values, artifact):
    knots = np.asarray(
        (artifact or {}).get("scoreQuantiles"),
        dtype=np.float64,
    )
    if (
        knots.ndim != 1
        or len(knots) < 2
        or not np.isfinite(knots).all()
        or np.any(np.diff(knots) < 0)
    ):
        raise ValueError("决策排序分校准参数无效")
    percentiles = np.linspace(0.0, 1.0, len(knots))
    return np.clip(np.interp(values, knots, percentiles), 0, 1)


def rank_expected_net_r(values, artifact):
    scores = np.asarray(
        (artifact or {}).get("score"),
        dtype=np.float64,
    )
    expected = np.asarray(
        (artifact or {}).get("expectedNetR"),
        dtype=np.float64,
    )
    if (
        scores.ndim != 1
        or expected.shape != scores.shape
        or len(scores) < 2
        or not np.isfinite(scores).all()
        or not np.isfinite(expected).all()
        or np.any(np.diff(scores) < 0)
    ):
        raise ValueError("决策排序价值校准参数无效")
    return np.interp(values, scores, expected)


def predict_ranking(model, matrix, percentile_artifact, value_artifact):
    raw = model_prediction(model, matrix)
    return {
        "raw": raw,
        "percentile": empirical_percentile(
            raw,
            percentile_artifact,
        ),
        "expected_net_r": rank_expected_net_r(
            raw,
            value_artifact,
        ),
    }
