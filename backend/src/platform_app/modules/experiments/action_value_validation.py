"""Leakage-resistant validation and calibration primitives for action value."""

from dataclasses import dataclass
from typing import Any

import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression

FOLD_COUNT = 5
MINIMUM_TRAIN_SESSIONS = 126
CALIBRATION_SESSIONS = 63
MINIMUM_TEST_SESSIONS = 63
PURGE_SESSIONS = 5
EMBARGO_SESSIONS = 5
RANDOM_STATE = 97240


class ActionValueValidationError(ValueError):
    pass


@dataclass(frozen=True)
class ActionValueFold:
    fold: int
    train_end: int
    calibration_start: int
    calibration_end: int
    test_start: int
    test_end: int
    purge_sessions: int = PURGE_SESSIONS
    embargo_sessions: int = EMBARGO_SESSIONS

    def masks(self, dates) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        values = np.asarray(dates)
        return (
            values <= self.train_end,
            (values >= self.calibration_start) & (values <= self.calibration_end),
            (values >= self.test_start) & (values <= self.test_end),
        )

    def as_dict(self) -> dict:
        return {
            "fold": self.fold,
            "trainEnd": str(self.train_end),
            "calibrationStart": str(self.calibration_start),
            "calibrationEnd": str(self.calibration_end),
            "testStart": str(self.test_start),
            "testEnd": str(self.test_end),
            "purgeSessions": self.purge_sessions,
            "embargoSessions": self.embargo_sessions,
        }


def nested_walk_forward_splits(
    dates,
    *,
    fold_count: int = FOLD_COUNT,
    minimum_train_sessions: int = MINIMUM_TRAIN_SESSIONS,
    calibration_sessions: int = CALIBRATION_SESSIONS,
    minimum_test_sessions: int = MINIMUM_TEST_SESSIONS,
    purge_sessions: int = PURGE_SESSIONS,
    embargo_sessions: int = EMBARGO_SESSIONS,
) -> list[ActionValueFold]:
    unique = np.unique(np.asarray(dates))
    minimum = (
        minimum_train_sessions
        + purge_sessions
        + calibration_sessions
        + embargo_sessions
        + fold_count * minimum_test_sessions
    )
    if (
        fold_count < 2
        or min(
            minimum_train_sessions,
            calibration_sessions,
            minimum_test_sessions,
            purge_sessions,
            embargo_sessions,
        )
        <= 0
        or len(unique) < minimum
    ):
        raise ActionValueValidationError(
            "ACTION_VALUE_WALK_FORWARD_SUPPORT_INSUFFICIENT"
        )

    first_test_index = (
        minimum_train_sessions
        + purge_sessions
        + calibration_sessions
        + embargo_sessions
    )
    blocks = np.array_split(unique[first_test_index:], fold_count)
    if any(len(block) < minimum_test_sessions for block in blocks):
        raise ActionValueValidationError(
            "ACTION_VALUE_WALK_FORWARD_SUPPORT_INSUFFICIENT"
        )
    folds = []
    for fold_number, block in enumerate(blocks, 1):
        test_start_index = int(np.searchsorted(unique, block[0]))
        calibration_end_index = test_start_index - embargo_sessions - 1
        calibration_start_index = calibration_end_index - calibration_sessions + 1
        train_end_index = calibration_start_index - purge_sessions - 1
        folds.append(
            ActionValueFold(
                fold=fold_number,
                train_end=int(unique[train_end_index]),
                calibration_start=int(unique[calibration_start_index]),
                calibration_end=int(unique[calibration_end_index]),
                test_start=int(block[0]),
                test_end=int(block[-1]),
                purge_sessions=purge_sessions,
                embargo_sessions=embargo_sessions,
            )
        )
    return folds


def inner_validation_masks(
    dates,
    outer_train_mask,
    *,
    minimum_train_sessions: int = 63,
    validation_sessions: int = 42,
    purge_sessions: int = PURGE_SESSIONS,
) -> tuple[np.ndarray, np.ndarray]:
    dates = np.asarray(dates)
    outer_train = np.asarray(outer_train_mask, dtype=bool)
    if outer_train.shape != dates.shape:
        raise ActionValueValidationError("ACTION_VALUE_INNER_MASK_INVALID")
    unique = np.unique(dates[outer_train])
    if len(unique) < minimum_train_sessions + purge_sessions + validation_sessions:
        raise ActionValueValidationError("ACTION_VALUE_INNER_SUPPORT_INSUFFICIENT")
    validation_start_index = len(unique) - validation_sessions
    train_end_index = validation_start_index - purge_sessions - 1
    train = outer_train & (dates <= unique[train_end_index])
    validation = outer_train & (dates >= unique[validation_start_index])
    return train, validation


def weighted_quantile(values, weights, quantile: float) -> float:
    values = np.asarray(values, dtype=np.float64)
    weights = np.asarray(weights, dtype=np.float64)
    if (
        values.ndim != 1
        or weights.shape != values.shape
        or not len(values)
        or not 0 <= quantile <= 1
        or not np.all(np.isfinite(values))
        or not np.all(np.isfinite(weights))
        or np.any(weights <= 0)
    ):
        raise ActionValueValidationError("ACTION_VALUE_WEIGHTED_QUANTILE_INVALID")
    order = np.argsort(values, kind="stable")
    cumulative = np.cumsum(weights[order])
    index = min(
        int(np.searchsorted(cumulative, quantile * cumulative[-1], side="left")),
        len(values) - 1,
    )
    return float(values[order[index]])


def _logit(values):
    clipped = np.clip(np.asarray(values, dtype=np.float64), 1e-6, 1 - 1e-6)
    return np.log(clipped / (1 - clipped))


@dataclass(frozen=True)
class ProbabilityCalibrator:
    method: str
    model: Any

    def predict(self, raw_probability) -> np.ndarray:
        raw = np.asarray(raw_probability, dtype=np.float64)
        if self.method == "sigmoid":
            values = self.model.predict_proba(_logit(raw).reshape(-1, 1))[:, 1]
        else:
            values = self.model.predict(raw)
        return np.clip(np.asarray(values, dtype=np.float64), 0, 1)


def fit_probability_calibrator(
    raw_probability,
    labels,
    weights,
    *,
    method: str = "sigmoid",
) -> ProbabilityCalibrator:
    raw = np.asarray(raw_probability, dtype=np.float64)
    labels = np.asarray(labels, dtype=np.int8)
    weights = np.asarray(weights, dtype=np.float64)
    if (
        method not in {"sigmoid", "isotonic"}
        or raw.ndim != 1
        or labels.shape != raw.shape
        or weights.shape != raw.shape
        or len(np.unique(labels)) != 2
        or not np.all(np.isfinite(raw))
        or not np.all(np.isfinite(weights))
        or np.any(weights <= 0)
    ):
        raise ActionValueValidationError(
            "ACTION_VALUE_PROBABILITY_CALIBRATION_INVALID"
        )
    if method == "sigmoid":
        model = LogisticRegression(C=1.0, random_state=RANDOM_STATE).fit(
            _logit(raw).reshape(-1, 1),
            labels,
            sample_weight=weights,
        )
    else:
        model = IsotonicRegression(out_of_bounds="clip").fit(
            raw,
            labels,
            sample_weight=weights,
        )
    return ProbabilityCalibrator(method=method, model=model)


def conformal_interval_correction(
    q10,
    q90,
    actual,
    weights,
    *,
    coverage: float = 0.8,
) -> float:
    q10 = np.asarray(q10, dtype=np.float64)
    q90 = np.asarray(q90, dtype=np.float64)
    actual = np.asarray(actual, dtype=np.float64)
    if q10.shape != q90.shape or q10.shape != actual.shape or np.any(q10 > q90):
        raise ActionValueValidationError("ACTION_VALUE_CONFORMAL_INPUT_INVALID")
    score = np.maximum(q10 - actual, actual - q90)
    return max(0.0, weighted_quantile(score, weights, coverage))


def apply_conformal_interval(q10, q50, q90, correction):
    q10 = np.asarray(q10, dtype=np.float64)
    q50 = np.asarray(q50, dtype=np.float64)
    q90 = np.asarray(q90, dtype=np.float64)
    if (
        q10.shape != q50.shape
        or q10.shape != q90.shape
        or np.any(q10 > q50)
        or np.any(q50 > q90)
        or not np.isfinite(correction)
        or correction < 0
    ):
        raise ActionValueValidationError("ACTION_VALUE_CONFORMAL_INPUT_INVALID")
    return q10 - correction, q50, q90 + correction
