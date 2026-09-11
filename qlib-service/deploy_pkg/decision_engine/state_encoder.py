"""Shared state-vector preparation and distribution checks."""

from __future__ import annotations

import numpy as np

from .contracts import feature_vector


STATE_ENCODER_VERSION = "state-encoder.tree-v1"


def encode_items(items, feature_names):
    matrix = np.asarray(
        [
            feature_vector(item, feature_names)
            for item in items
        ],
        dtype=np.float32,
    )
    if (
        matrix.ndim != 2
        or matrix.shape[1] != len(feature_names)
        or not np.isfinite(matrix).all()
    ):
        raise ValueError("决策状态编码结果无效")
    return matrix


def is_out_of_distribution(vector, metadata):
    config = (metadata or {}).get("ood") or {}
    minimum = np.asarray(config.get("minimum"), dtype=np.float64)
    maximum = np.asarray(config.get("maximum"), dtype=np.float64)
    values = np.asarray(vector, dtype=np.float64)
    if (
        minimum.shape != values.shape
        or maximum.shape != values.shape
        or not np.isfinite(minimum).all()
        or not np.isfinite(maximum).all()
    ):
        return True
    span = np.maximum(maximum - minimum, 1e-6)
    tolerance = span * 0.05
    feature_names = tuple(metadata.get("featureNames") or ())
    for index, name in enumerate(feature_names):
        if (
            name.endswith("_UNKNOWN")
            and values[index] >= 0.5
            and maximum[index] < 0.5
        ):
            return True
    violations = (
        (values < minimum - tolerance)
        | (values > maximum + tolerance)
    )
    limit = float(config.get("maximumViolationFraction", 0.1))
    return float(violations.mean()) > max(0.0, min(1.0, limit))
