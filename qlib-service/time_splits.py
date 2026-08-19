import math

import numpy as np


def _dates(values):
    dates = np.asarray(values).astype(str)
    if dates.ndim != 1 or not len(dates):
        raise ValueError("dates must be a non-empty one-dimensional array")
    return dates, np.unique(dates)


def _purge(value):
    if not isinstance(value, int) or value < 0:
        raise ValueError("purge_dates must be a non-negative integer")
    return value


def purged_holdout_split(
    dates,
    *,
    holdout_fraction=0.15,
    purge_dates=5,
):
    dates, unique_dates = _dates(dates)
    purge_dates = _purge(purge_dates)
    if not 0 < holdout_fraction < 0.5:
        raise ValueError("holdout_fraction must be between zero and 0.5")

    holdout_count = max(1, math.ceil(len(unique_dates) * holdout_fraction))
    holdout_position = len(unique_dates) - holdout_count
    purge_position = holdout_position - purge_dates
    if purge_position <= 0:
        raise ValueError("dataset is too short for the requested purge")

    holdout_start = unique_dates[holdout_position]
    purge_start = unique_dates[purge_position]
    train_index = np.flatnonzero(dates < purge_start)
    holdout_index = np.flatnonzero(dates >= holdout_start)
    if not len(train_index) or not len(holdout_index):
        raise ValueError("purged split produced an empty partition")
    return train_index, holdout_index, {
        "holdout_start_date": str(holdout_start),
        "purge_start_date": str(purge_start),
        "purge_dates": purge_dates,
        "purged_date_values": unique_dates[
            purge_position:holdout_position
        ].astype(str).tolist(),
        "train_samples": int(len(train_index)),
        "holdout_samples": int(len(holdout_index)),
    }


def three_way_purged_split(
    dates,
    *,
    calibration_fraction=0.15,
    holdout_fraction=0.15,
    purge_dates=5,
):
    dates, unique_dates = _dates(dates)
    purge_dates = _purge(purge_dates)
    if not 0 < calibration_fraction < 0.5:
        raise ValueError("calibration_fraction must be between zero and 0.5")
    if not 0 < holdout_fraction < 0.5:
        raise ValueError("holdout_fraction must be between zero and 0.5")
    if calibration_fraction + holdout_fraction >= 0.8:
        raise ValueError("calibration and holdout fractions are too large")

    calibration_count = max(
        1,
        math.ceil(len(unique_dates) * calibration_fraction),
    )
    holdout_count = max(1, math.ceil(len(unique_dates) * holdout_fraction))
    holdout_position = len(unique_dates) - holdout_count
    holdout_purge_position = holdout_position - purge_dates
    calibration_position = holdout_purge_position - calibration_count
    calibration_purge_position = calibration_position - purge_dates
    if calibration_purge_position <= 0:
        raise ValueError("dataset is too short for the requested purges")

    calibration_start = unique_dates[calibration_position]
    holdout_purge_start = unique_dates[holdout_purge_position]
    holdout_start = unique_dates[holdout_position]
    calibration_purge_start = unique_dates[calibration_purge_position]
    train_index = np.flatnonzero(dates < calibration_purge_start)
    calibration_index = np.flatnonzero(
        (dates >= calibration_start) & (dates < holdout_purge_start)
    )
    holdout_index = np.flatnonzero(dates >= holdout_start)
    if not all(map(len, (train_index, calibration_index, holdout_index))):
        raise ValueError("purged split produced an empty partition")

    metadata = {
        "train_end_date": str(unique_dates[calibration_purge_position - 1]),
        "calibration_start_date": str(calibration_start),
        "calibration_end_date": str(unique_dates[holdout_purge_position - 1]),
        "holdout_start_date": str(holdout_start),
        "purge_dates": purge_dates,
        "calibration_purge_dates": unique_dates[
            calibration_purge_position:calibration_position
        ].astype(str).tolist(),
        "holdout_purge_dates": unique_dates[
            holdout_purge_position:holdout_position
        ].astype(str).tolist(),
        "train_samples": int(len(train_index)),
        "calibration_samples": int(len(calibration_index)),
        "holdout_samples": int(len(holdout_index)),
    }
    return train_index, calibration_index, holdout_index, metadata


def expanding_date_folds(dates, *, n_splits=5, purge_dates=5):
    dates, unique_dates = _dates(dates)
    purge_dates = _purge(purge_dates)
    if not isinstance(n_splits, int) or n_splits < 1:
        raise ValueError("n_splits must be a positive integer")
    if len(unique_dates) < n_splits + purge_dates + 2:
        raise ValueError("dataset is too short for the requested folds")

    blocks = np.array_split(unique_dates, n_splits + 1)
    folds = []
    for validation_dates in blocks[1:]:
        if not len(validation_dates):
            continue
        start_position = int(
            np.searchsorted(unique_dates, validation_dates[0])
        )
        train_end = start_position - purge_dates
        if train_end <= 0:
            continue
        train_dates = unique_dates[:train_end]
        train_index = np.flatnonzero(np.isin(dates, train_dates))
        validation_index = np.flatnonzero(
            np.isin(dates, validation_dates)
        )
        if len(train_index) and len(validation_index):
            folds.append((train_index, validation_index))
    if not folds:
        raise ValueError("purged folds produced no usable partitions")
    return folds
