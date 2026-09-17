import json
import sqlite3
from decimal import Decimal

import numpy as np
import pytest

from platform_app.modules.experiments.foundation_return_dataset import (
    FoundationReturnDatasetError,
    reference_full_fill_net_return,
)
from platform_app.modules.experiments.foundation_teacher_runner import (
    DEFAULT_CONTEXT_LENGTH,
    FoundationTeacherError,
    TeacherRawForecast,
    TeacherDataset,
    common_quantile_predictions,
    _adjusted_close_context,
    _daily_quotas,
    _partition_samples,
    _score,
    evaluate_teacher_test,
    fee_adjusted_returns,
    load_teacher_forecast,
    price_forecasts_to_fee_adjusted_returns,
    select_forecast_steps,
)


class HistoryReader:
    def load_history_sequence(
        self,
        instrument_id: str,
        decision_date: str,
    ) -> dict:
        del instrument_id
        return {
            "decisionDate": decision_date,
            "rows": [
                {"adjustedClose": str(value)}
                for value in np.linspace(10.0, 11.0, DEFAULT_CONTEXT_LENGTH)
            ],
        }


class IncompleteHistoryReader:
    def load_history_sequence(
        self,
        instrument_id: str,
        decision_date: str,
    ) -> dict:
        del instrument_id, decision_date
        raise FoundationReturnDatasetError(
            "FOUNDATION_HISTORY_SEQUENCE_INCOMPLETE",
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
                "20980101",
                "20990101" if terminal != "20991231" else terminal,
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


def test_teacher_fee_returns_match_frozen_decimal_policy():
    gross = np.array([-0.1, 0.0, 0.034567])
    boards = np.array(["MAIN", "BEIJING", "STAR"])
    executions = np.array(["20210104", "20220428", "20220429"])
    terminals = np.array(["20210111", "20220429", "20230828"])

    actual = fee_adjusted_returns(
        gross,
        boards,
        executions,
        terminals,
    )
    expected = np.asarray(
        [
            float(
                reference_full_fill_net_return(
                    gross_return=Decimal(str(value)),
                    board=board,
                    execution_date=execution,
                    terminal_date=terminal,
                )
            )
            for value, board, execution, terminal in zip(
                gross,
                boards,
                executions,
                terminals,
                strict=True,
            )
        ]
    )

    np.testing.assert_allclose(actual, expected, atol=1e-12, rtol=0)


def test_price_forecasts_convert_to_frozen_fee_adjusted_returns():
    predicted_prices = np.array(
        [
            [105.0, 110.0],
            [49.0, 50.0],
        ]
    )
    reference_close = np.array([100.0, 50.0])
    boards = np.array([0, 3])
    executions = np.array([20210104, 20220428])
    terminals = np.array([20210111, 20230828])

    actual = price_forecasts_to_fee_adjusted_returns(
        predicted_prices,
        reference_close,
        boards,
        executions,
        terminals,
    )
    expected = fee_adjusted_returns(
        np.array([0.05, 0.10, -0.02, 0.0]),
        np.array(["MAIN", "MAIN", "BEIJING", "BEIJING"]),
        np.array(["20210104", "20210104", "20220428", "20220428"]),
        np.array(["20210111", "20210111", "20230828", "20230828"]),
    ).reshape(2, 2)

    np.testing.assert_allclose(actual, expected, atol=1e-12, rtol=0)


def test_adjusted_close_context_ends_on_reference_close():
    context, reference_close = _adjusted_close_context(
        HistoryReader(),
        instrument_id="000001.SZ",
        decision_date="20200528",
    )

    assert context.shape == (DEFAULT_CONTEXT_LENGTH,)
    assert np.all(np.isfinite(context))
    assert reference_close == pytest.approx(context[-1])


def test_adjusted_close_context_skips_incomplete_market_history():
    assert (
        _adjusted_close_context(
            IncompleteHistoryReader(),
            instrument_id="000001.SZ",
            decision_date="20200528",
        )
        is None
    )


def test_partition_samples_preserve_decision_date():
    connection = ranking_database()

    dataset = _partition_samples(
        connection,
        HistoryReader(),
        fold=1,
        partition="test",
        start="20200407",
        end="20200407",
        samples_per_date=1,
        minimum_per_date=1,
    )

    assert dataset.dates.tolist() == [20200407]
    assert dataset.partitions.tolist() == [b"test"]
    assert dataset.forecast_steps.tolist() == [5]
    assert dataset.reference_close.tolist() == pytest.approx([11.0])
    assert dataset.execution_dates.tolist() == [20980101]
    assert dataset.terminal_dates.tolist() == [20991231]
    connection.close()


def test_teacher_dataset_rejects_wrong_context_shape():
    with pytest.raises(
        FoundationTeacherError,
        match="FOUNDATION_TEACHER_DATASET_INVALID",
    ):
        TeacherDataset(
            contexts=np.ones((2, DEFAULT_CONTEXT_LENGTH - 1)),
            reference_close=np.ones(2),
            actual_return=np.zeros(2),
            dates=np.array([20200101, 20200101]),
            execution_dates=np.array([20200102, 20200102]),
            terminal_dates=np.array([20200108, 20200108]),
            instruments=np.array([b"a", b"b"]),
            boards=np.zeros(2),
            sample_weight=np.ones(2),
            forecast_steps=np.full(2, 5),
            folds=np.ones(2),
            partitions=np.array([b"test", b"test"]),
        )


def test_forecast_steps_select_each_samples_target_horizon():
    values = np.arange(15).reshape(3, 5)

    selected = select_forecast_steps(values, np.array([1, 3, 5]))

    np.testing.assert_array_equal(selected, np.array([0, 7, 14]))


def test_ttm_quantiles_use_calibration_residuals_only():
    predicted = common_quantile_predictions(
        model_name="ttm-r2.1",
        selected_point=np.array([0.1, 0.2]),
        selected_native_quantiles=np.empty((2, 0)),
        native_levels=(),
        calibration_residual_quantiles=np.array(
            [-0.05, -0.02, 0.0, 0.03, 0.08]
        ),
    )

    np.testing.assert_allclose(
        predicted[0],
        np.array([0.05, 0.08, 0.1, 0.13, 0.18]),
    )


def test_native_quantiles_receive_calibration_median_residual():
    predicted = common_quantile_predictions(
        model_name="timesfm-2.5",
        selected_point=np.array([0.1]),
        selected_native_quantiles=np.array([[0.02, 0.05, 0.09]]),
        native_levels=(0.1, 0.5, 0.9),
        calibration_residual_quantiles=np.array(
            [-0.05, -0.02, 0.01, 0.03, 0.08]
        ),
    )

    np.testing.assert_allclose(
        predicted[0],
        np.array([0.03, 0.04125, 0.06, 0.085, 0.10]),
    )


def test_teacher_evaluation_uses_calibration_and_test_partitions():
    contexts = np.ones((8, DEFAULT_CONTEXT_LENGTH), dtype=np.float32)
    dataset = TeacherDataset(
        contexts=contexts,
        reference_close=np.ones(8, dtype=np.float32),
        actual_return=np.array(
            [-0.02, 0.01, 0.03, 0.04, -0.01, 0.02, 0.05, 0.08],
            dtype=np.float32,
        ),
        dates=np.array(
            [
                20200101,
                20200101,
                20200102,
                20200102,
                20200201,
                20200201,
                20200202,
                20200202,
            ]
        ),
        execution_dates=np.array(
            [20200103] * 4 + [20200203] * 4,
        ),
        terminal_dates=np.array(
            [20200110] * 4 + [20200210] * 4,
        ),
        instruments=np.asarray(
            [f"{index:06d}.SZ".encode() for index in range(8)],
            dtype="S9",
        ),
        boards=np.zeros(8, dtype=np.int8),
        sample_weight=np.ones(8),
        forecast_steps=np.full(8, 5),
        folds=np.ones(8, dtype=np.int8),
        partitions=np.array(
            [b"probabilityCalibration"] * 4 + [b"test"] * 4,
            dtype="S24",
        ),
    )
    point = np.tile(
        1.0 + np.arange(5, dtype=np.float32) / 100,
        (8, 1),
    )
    raw = TeacherRawForecast(
        point=point,
        quantiles=np.empty((8, 5, 0), dtype=np.float32),
        quantile_levels=(),
        inference_seconds=1.0,
    )

    metrics, predictions = evaluate_teacher_test(
        dataset,
        raw,
        model_name="ttm-r2.1",
        fold=1,
    )

    assert metrics["samples"] == 4
    assert metrics["dates"] == 2
    assert 0 <= metrics["interval80Coverage"] <= 1
    assert predictions["pWin"].shape == (4,)
    assert list(predictions) == [
        "dates",
        "instruments",
        "actualReturn",
        "sampleWeight",
        "pointNetProxy",
        "pWin",
        "q10",
        "q25",
        "q50",
        "q75",
        "q90",
    ]


def test_load_teacher_forecast_rejects_hash_drift(tmp_path):
    point = np.zeros((2, 5), dtype=np.float32)
    quantiles = np.zeros((2, 5, 0), dtype=np.float32)
    raw_path = tmp_path / "raw-forecast.npz"
    np.savez_compressed(
        raw_path,
        point=point,
        quantiles=quantiles,
        quantileLevels=np.asarray([]),
        inferenceSeconds=np.asarray(1.0),
    )
    import hashlib

    digest = hashlib.sha256(raw_path.read_bytes()).hexdigest()
    receipt = {
        "schemaVersion": "foundation-teacher-inference-receipt.v1",
        "model": "ttm-r2.1",
        "datasetSha256": "a" * 64,
        "rows": 2,
        "rawForecast": raw_path.name,
        "rawForecastSha256": digest,
    }
    (tmp_path / "receipt.json").write_text(json.dumps(receipt))

    raw, loaded = load_teacher_forecast(
        tmp_path,
        expected_dataset_sha256="a" * 64,
    )

    assert raw.point.shape == (2, 5)
    assert loaded["model"] == "ttm-r2.1"
    raw_path.write_bytes(b"drift")
    with pytest.raises(
        FoundationTeacherError,
        match="FOUNDATION_TEACHER_FORECAST_INVALID",
    ):
        load_teacher_forecast(
            tmp_path,
            expected_dataset_sha256="a" * 64,
        )


def test_daily_quota_requires_one_sample_per_date():
    with pytest.raises(
        FoundationTeacherError,
        match="FOUNDATION_TEACHER_SAMPLE_BUDGET_INVALID",
    ):
        _daily_quotas(["20200101", "20200102"], 1)
    with pytest.raises(
        FoundationTeacherError,
        match="FOUNDATION_TEACHER_SAMPLE_BUDGET_INVALID",
    ):
        _daily_quotas(
            ["20200101", "20200102"],
            30,
            minimum_per_date=20,
        )
