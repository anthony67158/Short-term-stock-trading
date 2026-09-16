"""Offline, purged temporal experiments. No production publication side effects."""

import numpy as np
from scipy.optimize import minimize

from platform_app.modules.experiments.quant_model_trainer import QuantModelError
from platform_app.modules.experiments.ranking_model_trainer import _percentile_ranks

CANDIDATES = ("rank5", "rank20", "rank100", "return")


def daily_percentiles(dates: np.ndarray, predictions: np.ndarray) -> np.ndarray:
    """Normalize only within each contemporaneous universe, never across dates."""
    predictions = np.asarray(predictions)
    if predictions.ndim != 2 or len(predictions) != len(dates):
        raise QuantModelError("COMBINATION_PREDICTION_SHAPE_INVALID")
    if not np.isfinite(predictions).all() or np.any(dates[1:] < dates[:-1]):
        raise QuantModelError("COMBINATION_PREDICTIONS_INVALID")
    result = np.empty_like(predictions, dtype=np.float32)
    _, starts, counts = np.unique(dates, return_index=True, return_counts=True)
    for start, count in zip(starts, counts, strict=True):
        for column in range(predictions.shape[1]):
            result[start : start + count, column] = _percentile_ranks(
                predictions[start : start + count, column]
            )
    return result


def temporal_fusion_weights(
    predictions: np.ndarray,
    target_rank: np.ndarray,
    dates: np.ndarray,
    *,
    model_train_end: int,
    test_start: int,
    shrinkage: float = 0.5,
) -> np.ndarray:
    """Fit nonnegative simplex weights to held-out, date-balanced rank targets.

    Caller enforces session purge using the frozen walk-forward split. Neither
    early stopping nor refitting on these dates is allowed for the base models.
    """
    if (
        len(dates) == 0
        or dates.min() <= model_train_end
        or dates.max() >= test_start
        or not 0 <= shrinkage <= 1
    ):
        raise QuantModelError("COMBINATION_FUSION_WINDOW_INVALID")
    x = np.asarray(predictions, dtype=np.float64)
    y = np.asarray(target_rank, dtype=np.float64)
    if (
        x.ndim != 2 or x.shape[0] != len(dates) or x.shape[1] == 0
        or y.shape != (len(dates),)
        or not np.isfinite(x).all() or not np.isfinite(y).all()
    ):
        raise QuantModelError("COMBINATION_FUSION_DATA_INVALID")
    _, inverse, counts = np.unique(dates, return_inverse=True, return_counts=True)
    sample_weight = 1 / (len(counts) * counts[inverse])
    gram = x.T @ (sample_weight[:, None] * x)
    linear = x.T @ (sample_weight * y)
    equal = np.full(x.shape[1], 1 / x.shape[1])
    solution = minimize(
        lambda w: float(w @ gram @ w - 2 * linear @ w),
        equal,
        jac=lambda w: 2 * (gram @ w - linear),
        method="SLSQP",
        bounds=[(0, 1)] * len(equal),
        constraints={"type": "eq", "fun": lambda w: w.sum() - 1,
                     "jac": lambda w: np.ones_like(w)},
        options={"ftol": 1e-12, "maxiter": 200},
    )
    if not solution.success:
        raise QuantModelError("COMBINATION_FUSION_OPTIMIZATION_FAILED")
    weights = np.maximum(solution.x, 0)
    weights /= weights.sum()
    return shrinkage * equal + (1 - shrinkage) * weights


def combination_scores(
    normalized_predictions: np.ndarray, weights: np.ndarray
) -> dict[str, np.ndarray]:
    scores = {
        name: normalized_predictions[:, index]
        for index, name in enumerate(CANDIDATES)
    }
    scores["equal"] = normalized_predictions.mean(axis=1)
    scores["temporal"] = normalized_predictions @ weights
    for index, name in enumerate(CANDIDATES):
        scores[f"equal_without_{name}"] = np.delete(
            normalized_predictions, index, axis=1
        ).mean(axis=1)
    return scores
