"""Shared prediction validation for decision heads."""

from __future__ import annotations

import numpy as np


def model_prediction(model, matrix):
    values = np.asarray(model.predict(matrix), dtype=np.float64)
    if values.shape != (len(matrix),) or not np.isfinite(values).all():
        raise ValueError("决策模型预测无效")
    return values
