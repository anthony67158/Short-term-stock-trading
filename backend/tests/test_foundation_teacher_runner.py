import sqlite3

import numpy as np
import pytest

from platform_app.modules.experiments.foundation_teacher_runner import (
    DEFAULT_CONTEXT_LENGTH,
    FoundationTeacherError,
    TeacherDataset,
    _daily_quotas,
    _mature_return_context,
    _partition_samples,
    _score,
)


def ranking_database() -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute(
        "CREATE TABLE ranking_samples ("
        "instrument_id TEXT, decision_date TEXT, board TEXT, "
        "execution_date TEXT, terminal_date TEXT, "
        "forward_return_next_open_5 TEXT)"
    )
    rows = []
    for index in range(95):
        date = f"2020{index // 28 + 1:02d}{index % 28 + 1:02d}"
        terminal = date if index < 90 else "20991231"
        rows.append(
            (
                "000001.SZ",
                date,
                "MAIN",
                date,
                terminal,
                str(index / 10_000),
            )
        )
    connection.executemany(
        "INSERT INTO ranking_samples VALUES (?, ?, ?, ?, ?, ?)",
        rows,
    )
    return connection


def test_daily_quotas_are_equal_and_deterministic():
    dates = ["20200101", "20200102", "20200103"]

    quotas = _daily_quotas(dates, 8)

    assert quotas == {
        "20200101": 3,
        "20200102": 3,
        "20200103": 2,
    }
    assert _score(1, "test", dates[0], "000001.SZ") == _score(
        1,
        "test",
        dates[0],
        "000001.SZ",
    )


def test_mature_context_excludes_unmatured_labels():
    connection = ranking_database()

    context = _mature_return_context(
        connection,
        instrument_id="000001.SZ",
        decision_date="20200528",
    )

    assert context is not None
    assert context.shape == (DEFAULT_CONTEXT_LENGTH,)
    assert np.all(np.isfinite(context))
    connection.close()


def test_partition_samples_preserve_decision_date():
    connection = ranking_database()

    dataset = _partition_samples(
        connection,
        fold=1,
        partition="test",
        start="20200407",
        end="20200407",
        samples=1,
    )

    assert dataset.dates.tolist() == [20200407]
    assert dataset.partitions.tolist() == [b"test"]
    connection.close()


def test_teacher_dataset_rejects_wrong_context_shape():
    with pytest.raises(
        FoundationTeacherError,
        match="FOUNDATION_TEACHER_DATASET_INVALID",
    ):
        TeacherDataset(
            contexts=np.zeros((2, DEFAULT_CONTEXT_LENGTH - 1)),
            actual_return=np.zeros(2),
            dates=np.ones(2),
            instruments=np.array([b"a", b"b"]),
            boards=np.zeros(2),
            sample_weight=np.ones(2),
            folds=np.ones(2),
            partitions=np.array([b"test", b"test"]),
        )


def test_daily_quota_requires_one_sample_per_date():
    with pytest.raises(
        FoundationTeacherError,
        match="FOUNDATION_TEACHER_SAMPLE_BUDGET_INVALID",
    ):
        _daily_quotas(["20200101", "20200102"], 1)
