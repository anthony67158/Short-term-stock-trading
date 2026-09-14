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


def _aligned_interval_inputs(
    dates,
    label_start_ms,
    label_end_ms,
    group_ids,
):
    dates, unique_dates = _dates(dates)
    starts = np.asarray(label_start_ms, dtype=np.int64)
    ends = np.asarray(label_end_ms, dtype=np.int64)
    groups = np.asarray(group_ids).astype(str)
    if any(
        value.ndim != 1 or len(value) != len(dates)
        for value in (starts, ends, groups)
    ):
        raise ValueError("interval split inputs must be aligned")
    if np.any(starts <= 0) or np.any(ends < starts):
        raise ValueError("label intervals must be positive and ordered")
    if np.any(np.char.str_len(groups) == 0):
        raise ValueError("group_ids must not contain empty values")
    return dates, unique_dates, starts, ends, groups


def four_way_interval_split(
    dates,
    label_start_ms,
    label_end_ms,
    group_ids,
    *,
    calibration_fraction=0.15,
    selection_fraction=0.15,
    confirmation_fraction=0.15,
    embargo_dates=5,
    minimum_partition_samples=30,
):
    (
        dates,
        unique_dates,
        starts,
        ends,
        groups,
    ) = _aligned_interval_inputs(
        dates,
        label_start_ms,
        label_end_ms,
        group_ids,
    )
    embargo_dates = _purge(embargo_dates)
    fractions = (
        calibration_fraction,
        selection_fraction,
        confirmation_fraction,
    )
    if any(not 0 < value < 0.5 for value in fractions):
        raise ValueError("split fractions must be between zero and 0.5")
    if sum(fractions) >= 0.8:
        raise ValueError("calibration, selection and confirmation are too large")
    if (
        not isinstance(minimum_partition_samples, int)
        or minimum_partition_samples < 1
    ):
        raise ValueError("minimum_partition_samples must be positive")

    calibration_count, selection_count, confirmation_count = (
        max(1, math.ceil(len(unique_dates) * value))
        for value in fractions
    )
    confirmation_position = len(unique_dates) - confirmation_count
    confirmation_embargo_position = (
        confirmation_position - embargo_dates
    )
    selection_position = (
        confirmation_embargo_position - selection_count
    )
    selection_embargo_position = selection_position - embargo_dates
    calibration_position = (
        selection_embargo_position - calibration_count
    )
    calibration_embargo_position = (
        calibration_position - embargo_dates
    )
    if calibration_embargo_position <= 0:
        raise ValueError("dataset is too short for four-way embargoes")

    ranges = {
        "train": (
            unique_dates[0],
            unique_dates[calibration_embargo_position - 1],
        ),
        "calibration": (
            unique_dates[calibration_position],
            unique_dates[selection_embargo_position - 1],
        ),
        "selection": (
            unique_dates[selection_position],
            unique_dates[confirmation_embargo_position - 1],
        ),
        "confirmation": (
            unique_dates[confirmation_position],
            unique_dates[-1],
        ),
    }
    raw = {
        name: np.flatnonzero(
            (dates >= start_date) & (dates <= end_date)
        )
        for name, (start_date, end_date) in ranges.items()
    }
    assigned_partition = {}
    for name, indices in raw.items():
        for index in indices:
            assigned_partition[int(index)] = name

    group_partitions = {}
    group_has_unassigned_row = {}
    for index, group in enumerate(groups):
        if index in assigned_partition:
            group_partitions.setdefault(group, set()).add(
                assigned_partition[index]
            )
        else:
            group_has_unassigned_row[group] = True
    invalid_groups = {
        group
        for group, partitions in group_partitions.items()
        if len(partitions) != 1 or group_has_unassigned_row.get(group, False)
    }

    boundaries = {
        "train": int(starts[raw["calibration"]].min()),
        "calibration": int(starts[raw["selection"]].min()),
        "selection": int(starts[raw["confirmation"]].min()),
    }
    interval_invalid_groups = set()
    for name, boundary in boundaries.items():
        crossed = raw[name][ends[raw[name]] >= boundary]
        interval_invalid_groups.update(groups[crossed].tolist())

    all_invalid_groups = invalid_groups | interval_invalid_groups
    partitions = {
        name: indices[
            ~np.isin(groups[indices], list(all_invalid_groups))
        ]
        for name, indices in raw.items()
    }
    undersized = {
        name: int(len(indices))
        for name, indices in partitions.items()
        if len(indices) < minimum_partition_samples
    }
    if undersized:
        details = ", ".join(
            f"{name}={count}"
            for name, count in undersized.items()
        )
        raise ValueError(f"四段分区样本不足: {details}")

    embargo_ranges = {
        "before_calibration": unique_dates[
            calibration_embargo_position:calibration_position
        ].astype(str).tolist(),
        "before_selection": unique_dates[
            selection_embargo_position:selection_position
        ].astype(str).tolist(),
        "before_confirmation": unique_dates[
            confirmation_embargo_position:confirmation_position
        ].astype(str).tolist(),
    }
    metadata = {
        "schema_version": "four-way-label-interval-split.v1",
        "embargo_dates": embargo_dates,
        "embargo_date_values": embargo_ranges,
        "ranges": {
            name: {
                "start_date": str(start_date),
                "end_date": str(end_date),
            }
            for name, (start_date, end_date) in ranges.items()
        },
        "train_samples": int(len(partitions["train"])),
        "calibration_samples": int(len(partitions["calibration"])),
        "selection_samples": int(len(partitions["selection"])),
        "confirmation_samples": int(len(partitions["confirmation"])),
        "interval_purged_samples": int(np.count_nonzero(
            np.isin(groups, list(interval_invalid_groups))
        )),
        "group_purged_samples": int(np.count_nonzero(
            np.isin(groups, list(invalid_groups))
        )),
    }
    return (
        partitions["train"],
        partitions["calibration"],
        partitions["selection"],
        partitions["confirmation"],
        metadata,
    )


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
