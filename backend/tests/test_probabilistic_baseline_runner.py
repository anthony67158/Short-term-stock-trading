import json
from decimal import Decimal
import sqlite3

import numpy as np
import pytest

from platform_app.modules.experiments.foundation_return_dataset import (
    reference_full_fill_net_return,
)
from platform_app.modules.experiments.probabilistic_baseline_runner import (
    CATBOOST_FAMILY,
    LIGHTGBM_FAMILY,
    XGBOOST_FAMILY,
    BaselinePartition,
    ProbabilisticBaselineError,
    _load_partition_from_connections,
    _write_json,
    _write_predictions,
    baseline_library_versions,
    evaluate_predictions,
    fee_adjusted_returns,
    fit_catboost_baseline,
    fit_lightgbm_baseline,
    fit_xgboost_baseline,
    historical_baseline_predictions,
    normalized_weights,
    weighted_quantiles,
)
from platform_app.modules.experiments.ranking_model_trainer import (
    MODEL_FEATURE_NAMES,
    RAW_COLUMNS,
)


def partition() -> BaselinePartition:
    return BaselinePartition(
        x=np.zeros((4, 2), dtype=np.float32),
        dates=np.array([20200101, 20200101, 20200102, 20200102]),
        boards=np.array([0, 1, 2, 3], dtype=np.int8),
        instruments=np.array([b"a", b"b", b"c", b"d"]),
        target_return=np.array([-0.03, -0.01, 0.02, 0.08], dtype=np.float32),
        direction=np.array([0, 0, 1, 1], dtype=np.int8),
        sample_weight=np.array([1.0, 1.0, 2.0, 6.0]),
    )


def model_partition(rows: int = 80) -> BaselinePartition:
    rng = np.random.default_rng(20260917)
    x = rng.normal(size=(rows, 4)).astype(np.float32)
    target = (0.02 * x[:, 0] - 0.01 * x[:, 1]).astype(np.float32)
    return BaselinePartition(
        x=x,
        dates=np.repeat(np.arange(20200101, 20200101 + rows // 4), 4),
        boards=np.tile(np.arange(4, dtype=np.int8), rows // 4),
        instruments=np.asarray(
            [f"{index:06d}.SZ".encode() for index in range(rows)],
            dtype="S9",
        ),
        target_return=target,
        direction=(target > 0).astype(np.int8),
        sample_weight=np.linspace(1.0, 2.0, rows),
    )


def baseline_databases() -> tuple[sqlite3.Connection, sqlite3.Connection]:
    ranking = sqlite3.connect(":memory:")
    ranking.row_factory = sqlite3.Row
    raw_schema = ", ".join(f"{name} TEXT NOT NULL" for name in RAW_COLUMNS)
    ranking.execute(
        "CREATE TABLE ranking_samples ("
        "instrument_id TEXT, decision_date TEXT, board TEXT, "
        "execution_date TEXT, terminal_date TEXT, "
        f"{raw_schema}, forward_return_next_open_5 TEXT)"
    )
    columns = (
        "instrument_id",
        "decision_date",
        "board",
        "execution_date",
        "terminal_date",
        *RAW_COLUMNS,
        "forward_return_next_open_5",
    )
    for decision_date in ("20200101", "20200102"):
        for index, instrument in enumerate(("000001.SZ", "000002.SZ", "000003.SZ")):
            raw = {name: "1" for name in RAW_COLUMNS}
            raw["adjusted_return_1"] = str((0.0, 1.0, 10.0)[index])
            raw["forward_return_next_open_5"] = str((0.01, -0.02, 0.03)[index])
            values = {
                "instrument_id": instrument,
                "decision_date": decision_date,
                "board": "MAIN",
                "execution_date": "20200102",
                "terminal_date": "20200108",
                **raw,
            }
            ranking.execute(
                f"INSERT INTO ranking_samples ({', '.join(columns)}) "
                f"VALUES ({', '.join('?' for _ in columns)})",
                [values[name] for name in columns],
            )
    sampling = sqlite3.connect(":memory:")
    sampling.row_factory = sqlite3.Row
    sampling.executescript(
        "CREATE TABLE training_samples ("
        "fold INTEGER, decision_date TEXT, instrument_id TEXT, stratum_id TEXT);"
        "CREATE TABLE sampling_strata ("
        "fold INTEGER, decision_date TEXT, stratum_id TEXT, "
        "inverse_probability_weight TEXT);"
    )
    sampling.executemany(
        "INSERT INTO sampling_strata VALUES (1, '20200101', ?, ?)",
        [("a", "2"), ("b", "4")],
    )
    sampling.executemany(
        "INSERT INTO training_samples VALUES (1, '20200101', ?, ?)",
        [("000001.SZ", "a"), ("000002.SZ", "b")],
    )
    return ranking, sampling


def test_fee_adjusted_returns_match_frozen_decimal_policy():
    gross = np.array([-0.12, 0.0, 0.034567, 0.45], dtype=np.float64)
    boards = np.array(["MAIN", "BEIJING", "STAR", "CHINEXT"])
    execution_dates = np.array(
        ["20210104", "20220428", "20220429", "20230825"],
    )
    terminal_dates = np.array(
        ["20210111", "20220429", "20230828", "20230901"],
    )

    actual = fee_adjusted_returns(
        gross,
        boards,
        execution_dates,
        terminal_dates,
    )
    expected = np.array(
        [
            float(
                reference_full_fill_net_return(
                    gross_return=Decimal(str(value)),
                    board=board,
                    execution_date=execution_date,
                    terminal_date=terminal_date,
                )
            )
            for value, board, execution_date, terminal_date in zip(
                gross,
                boards,
                execution_dates,
                terminal_dates,
                strict=True,
            )
        ]
    )

    np.testing.assert_allclose(actual, expected, atol=1e-12, rtol=0)


def test_weighted_quantiles_use_inverse_probability_mass():
    actual = weighted_quantiles(
        np.array([-2.0, -1.0, 1.0, 3.0]),
        (0.1, 0.5, 0.9),
        sample_weight=np.array([1.0, 1.0, 2.0, 6.0]),
    )

    np.testing.assert_array_equal(actual, np.array([-2.0, 3.0, 3.0]))
    np.testing.assert_allclose(
        normalized_weights(np.array([1.0, 3.0])),
        np.array([0.5, 1.5]),
    )


def test_historical_baseline_repeats_frozen_training_distribution():
    predictions = historical_baseline_predictions(
        partition(),
        3,
        quantiles=(0.1, 0.5, 0.9),
    )

    np.testing.assert_array_equal(
        predictions["pWin"],
        np.full(3, 0.8, dtype=np.float32),
    )
    np.testing.assert_array_equal(
        predictions["q50"],
        np.full(3, 0.08, dtype=np.float32),
    )
    assert list(predictions) == ["pWin", "q10", "q50", "q90"]


def test_partition_loader_uses_full_date_features_then_training_selection():
    ranking, sampling = baseline_databases()
    contract = {
        "fold": 1,
        "trainStart": "20200101",
        "trainEnd": "20200101",
        "trainSelected": 2,
        "testStart": "20200102",
        "testEnd": "20200102",
        "testRows": 3,
    }

    training = _load_partition_from_connections(
        ranking,
        sampling,
        fold_contract=contract,
        partition="train",
    )
    test = _load_partition_from_connections(
        ranking,
        sampling,
        fold_contract=contract,
        partition="test",
    )

    market_return_index = MODEL_FEATURE_NAMES.index("marketMeanReturn1")
    np.testing.assert_allclose(
        training.x[:, market_return_index],
        np.full(2, 11 / 3),
    )
    np.testing.assert_array_equal(
        training.instruments,
        np.array([b"000001.SZ", b"000002.SZ"]),
    )
    np.testing.assert_array_equal(training.sample_weight, np.array([2.0, 4.0]))
    np.testing.assert_array_equal(
        test.sample_weight,
        np.full(3, 1 / 3),
    )
    assert len(test.x) == 3
    ranking.close()
    sampling.close()


def test_catboost_baseline_outputs_probability_and_ordered_quantiles():
    training = model_partition()

    model = fit_catboost_baseline(training, iterations=3, threads=1)
    predictions = model.predict(training.x[:7])

    assert model.family == CATBOOST_FAMILY
    assert predictions["pWin"].shape == (7,)
    assert np.all((predictions["pWin"] >= 0) & (predictions["pWin"] <= 1))
    quantiles = np.column_stack(
        [value for key, value in predictions.items() if key.startswith("q")]
    )
    assert quantiles.shape == (7, 7)
    assert np.all(np.diff(quantiles, axis=1) >= 0)
    assert baseline_library_versions()["catboost"] == "1.2.10"


def test_xgboost_baseline_outputs_probability_and_ordered_quantiles():
    training = model_partition()

    model = fit_xgboost_baseline(training, iterations=3, threads=1)
    predictions = model.predict(training.x[:7])

    assert model.family == XGBOOST_FAMILY
    assert predictions["pWin"].shape == (7,)
    assert np.all((predictions["pWin"] >= 0) & (predictions["pWin"] <= 1))
    quantiles = np.column_stack(
        [value for key, value in predictions.items() if key.startswith("q")]
    )
    assert quantiles.shape == (7, 7)
    assert np.all(np.diff(quantiles, axis=1) >= 0)
    assert baseline_library_versions()["xgboost"] == "3.4.1"


def test_lightgbm_baseline_outputs_probability_and_ordered_quantiles():
    training = model_partition()

    model = fit_lightgbm_baseline(training, iterations=3, threads=1)
    predictions = model.predict(training.x[:7])

    assert model.family == LIGHTGBM_FAMILY
    assert predictions["pWin"].shape == (7,)
    assert np.all((predictions["pWin"] >= 0) & (predictions["pWin"] <= 1))
    quantiles = np.column_stack(
        [value for key, value in predictions.items() if key.startswith("q")]
    )
    assert quantiles.shape == (7, 7)
    assert np.all(np.diff(quantiles, axis=1) >= 0)
    assert baseline_library_versions()["lightgbm"] == "4.7.0"


def test_evaluate_predictions_uses_fee_adjusted_distribution_and_daily_ranks():
    data = partition()
    offsets = (-0.03, -0.02, -0.01, 0.0, 0.01, 0.02, 0.03)
    predictions = {
        "pWin": np.where(data.direction == 1, 0.9, 0.1).astype(np.float32),
        **{
            name: data.target_return + offset
            for name, offset in zip(
                ("q05", "q10", "q25", "q50", "q75", "q90", "q95"),
                offsets,
                strict=True,
            )
        },
    }

    metrics = evaluate_predictions(data, predictions)

    assert metrics["samples"] == 4
    assert metrics["dates"] == 2
    assert metrics["brier"] == pytest.approx(0.01)
    assert metrics["interval80Coverage"] == 1.0
    assert metrics["interval80MeanWidth"] == pytest.approx(0.04)
    assert metrics["ranking"]["meanDailyRankIc"] == pytest.approx(1.0)


def test_artifact_writes_are_atomic_and_immutable(tmp_path):
    metadata = tmp_path / "protocol.json"
    _write_json(metadata, {"version": 1}, immutable=True)
    _write_json(metadata, {"version": 1}, immutable=True)
    assert json.loads(metadata.read_text()) == {"version": 1}
    with pytest.raises(
        ProbabilisticBaselineError,
        match="PROBABILISTIC_BASELINE_ARTIFACT_MISMATCH",
    ):
        _write_json(metadata, {"version": 2}, immutable=True)

    data = partition()
    predictions = historical_baseline_predictions(data, len(data.x))
    output = tmp_path / "predictions.npz"
    _write_predictions(output, data, predictions)
    with np.load(output, allow_pickle=False) as saved:
        np.testing.assert_array_equal(saved["dates"], data.dates)
        np.testing.assert_array_equal(saved["actualReturn"], data.target_return)
        np.testing.assert_array_equal(saved["pWin"], predictions["pWin"])


def test_baseline_primitives_reject_invalid_inputs():
    with pytest.raises(
        ProbabilisticBaselineError,
        match="PROBABILISTIC_BASELINE_PARTITION_INVALID",
    ):
        BaselinePartition(
            x=np.zeros((2, 1)),
            dates=np.array([20200101]),
            boards=np.array([0, 1]),
            instruments=np.array([b"a", b"b"]),
            target_return=np.array([0.0, 0.1]),
            direction=np.array([0, 1]),
            sample_weight=np.array([1.0, 1.0]),
        )
    with pytest.raises(
        ProbabilisticBaselineError,
        match="PROBABILISTIC_BASELINE_WEIGHT_INVALID",
    ):
        normalized_weights(np.array([1.0, 0.0]))
    with pytest.raises(
        ProbabilisticBaselineError,
        match="PROBABILISTIC_BASELINE_LABEL_INPUT_INVALID",
    ):
        fee_adjusted_returns(
            np.array([-1.0]),
            np.array(["MAIN"]),
            np.array(["20200101"]),
            np.array(["20200102"]),
        )
    invalid_predictions = historical_baseline_predictions(partition(), 4)
    invalid_predictions["q10"] = invalid_predictions["q90"] + 1
    with pytest.raises(
        ProbabilisticBaselineError,
        match="PROBABILISTIC_BASELINE_QUANTILE_CROSSING",
    ):
        evaluate_predictions(partition(), invalid_predictions)
    ranking, sampling = baseline_databases()
    with pytest.raises(
        ProbabilisticBaselineError,
        match="PROBABILISTIC_BASELINE_MAXIMUM_DATES_INVALID",
    ):
        _load_partition_from_connections(
            ranking,
            sampling,
            fold_contract={"fold": 1},
            partition="train",
            maximum_dates=0,
        )
    ranking.close()
    sampling.close()
