"""Shared, leak-free dataset preparation for V3 model POCs."""

import copy
import gzip
import json
import math

import numpy as np

from opportunity_dataset import build_opportunity_dataset
from opportunity_history import (
    normalize_history_outcomes,
    repair_outcome_net_r,
)


POC_DATASET_SCHEMA_VERSION = "v3-model-poc-dataset.v1"
TIME_BUCKETS = (
    "INTRADAY_OPEN",
    "INTRADAY_MORNING",
    "INTRADAY_AFTERNOON",
    "INTRADAY_CLOSE",
    "INTRADAY_MANUAL",
    "CLOSE_NEXT_SESSION",
)


def slot_minutes(value):
    text = str(value or "").strip()
    if len(text) == 4 and text.isdigit():
        hours = int(text[:2])
        minutes = int(text[2:])
        if 0 <= hours <= 23 and 0 <= minutes <= 59:
            return hours * 60 + minutes
    try:
        minutes = int(value)
    except (TypeError, ValueError):
        return None
    return minutes if 0 <= minutes < 24 * 60 else None


def time_bucket(mode, slot):
    if str(mode or "").upper() == "CLOSE":
        return "CLOSE_NEXT_SESSION"
    minutes = slot_minutes(slot)
    if minutes is None:
        return "INTRADAY_MANUAL"
    if minutes <= 630:
        return "INTRADAY_OPEN"
    if minutes <= 690:
        return "INTRADAY_MORNING"
    if minutes <= 840:
        return "INTRADAY_AFTERNOON"
    return "INTRADAY_CLOSE"


def normalize_poc_outcome(value):
    repaired = copy.deepcopy(repair_outcome_net_r(value))
    score_input = repaired.get("scoreInput") or {}
    factors = score_input.get("factors") or {}
    dimensions = score_input.get("dimensions") or {}
    selected = time_bucket(repaired.get("mode"), repaired.get("slot"))
    score_input["dimensions"] = {
        **dimensions,
        "timeBucket": selected,
    }
    score_input["factors"] = {
        **factors,
        **{
            f"time_{bucket}": 1.0 if bucket == selected else 0.0
            for bucket in TIME_BUCKETS
        },
    }
    repaired["scoreInput"] = score_input
    return repaired


def load_poc_history(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        payload = json.load(handle)
    return [
        normalize_poc_outcome(value)
        for value in normalize_history_outcomes(payload)
    ]


def build_poc_dataset(path):
    outcomes = load_poc_history(path)
    dataset = build_opportunity_dataset(outcomes)
    if len(outcomes) != len(dataset["X"]):
        raise ValueError("POC历史样本与训练矩阵行数不一致")
    starts = []
    ends = []
    decision_ids = []
    for value in outcomes:
        start = int(
            (value.get("scoreInput") or {}).get("asOf")
            or value.get("signalAt")
            or 0
        )
        end = int(
            (value.get("exit") or {}).get("at")
            or value.get("evaluatedAt")
            or 0
        )
        if start <= 0 or end < start:
            raise ValueError("POC样本标签区间无效")
        starts.append(start)
        ends.append(end)
        decision_ids.append(str(value.get("decisionId") or ""))
    return {
        **dataset,
        "schema_version": POC_DATASET_SCHEMA_VERSION,
        "decision_ids": np.asarray(decision_ids, dtype="<U180"),
        "label_start_ms": np.asarray(starts, dtype=np.int64),
        "label_end_ms": np.asarray(ends, dtype=np.int64),
    }


def _calibration_split(dataset, outer_train, fraction):
    dates = dataset["dates"]
    available_dates = np.unique(dates[outer_train])
    calibration_count = max(1, math.ceil(len(available_dates) * fraction))
    calibration_dates = available_dates[-calibration_count:]
    calibration = outer_train[np.isin(
        dates[outer_train],
        calibration_dates,
    )]
    calibration_start = int(
        dataset["label_start_ms"][calibration].min()
    )
    train = outer_train[
        (dates[outer_train] < calibration_dates[0])
        & (dataset["label_end_ms"][outer_train] < calibration_start)
    ]
    if not len(train) or not len(calibration):
        raise ValueError("POC校准切分为空")
    return train, calibration


def interval_expanding_folds(
    dataset,
    *,
    n_splits=3,
    calibration_fraction=0.15,
):
    dates = np.asarray(dataset["dates"]).astype(str)
    unique_dates = np.unique(dates)
    if len(unique_dates) < n_splits + 3:
        raise ValueError("POC交易日不足")
    blocks = np.array_split(unique_dates, n_splits + 1)
    folds = []
    for validation_dates in blocks[1:]:
        validation = np.flatnonzero(np.isin(dates, validation_dates))
        validation_start = int(
            dataset["label_start_ms"][validation].min()
        )
        outer_train = np.flatnonzero(
            (dates < validation_dates[0])
            & (dataset["label_end_ms"] < validation_start)
        )
        train, calibration = _calibration_split(
            dataset,
            outer_train,
            calibration_fraction,
        )
        folds.append({
            "train": train,
            "calibration": calibration,
            "validation": validation,
            "metadata": {
                "trainStartDate": min(dates[train].tolist()),
                "trainEndDate": max(dates[train].tolist()),
                "calibrationStartDate":
                    min(dates[calibration].tolist()),
                "calibrationEndDate":
                    max(dates[calibration].tolist()),
                "validationStartDate": str(validation_dates[0]),
                "validationEndDate": str(validation_dates[-1]),
                "trainSamples": int(len(train)),
                "calibrationSamples": int(len(calibration)),
                "validationSamples": int(len(validation)),
                "purgedSamples": int(
                    np.count_nonzero(dates < validation_dates[0])
                    - len(outer_train)
                ),
            },
        })
    return folds
