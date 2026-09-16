import numpy as np
import pytest

from platform_app.modules.experiments.quant_model_trainer import QuantModelError
from platform_app.modules.experiments import ranking_model_trainer
from platform_app.modules.experiments.ranking_model_trainer import (
    BOARD_PERCENTILE_TARGET,
    GLOBAL_PERCENTILE_TARGET,
    LAMBDARANK_MODEL_FAMILY,
    MODEL_FEATURE_NAMES,
    RAW_COLUMNS,
    RankingTrainingData,
    _date_features,
    _linear_label_gain,
    _relevance_labels,
    train_ranking_models,
    write_ranking_bundle,
)


def test_relevance_labels_preserve_requested_resolution():
    ranks = np.asarray([0, 0.049, 0.05, 0.5, 0.999, 1], dtype=np.float32)

    np.testing.assert_array_equal(
        _relevance_labels(ranks, levels=20),
        np.asarray([0, 0, 1, 10, 19, 19]),
    )
    bin_centers = (np.arange(100, dtype=np.float32) + 0.5) / 100
    assert len(np.unique(_relevance_labels(bin_centers, levels=100))) == 100

    with pytest.raises(QuantModelError, match="RANKING_RELEVANCE_LEVELS_INVALID"):
        _relevance_labels(ranks, levels=1)
    assert _linear_label_gain(100) == list(range(100))


def test_global_target_compares_returns_across_boards():
    rows = []
    for board, forward_return in zip(
        ("MAIN", "CHINEXT", "STAR", "BEIJING"),
        ("-0.02", "0.01", "0.03", "0.08"),
        strict=True,
    ):
        row = {column: "1" for column in RAW_COLUMNS}
        row.update(
            {
                "board": board,
                "forward_return_next_open_5": forward_return,
            }
        )
        rows.append(row)

    _, board_target = _date_features(
        rows,
        target_policy=BOARD_PERCENTILE_TARGET,
    )
    _, global_target = _date_features(
        rows,
        target_policy=GLOBAL_PERCENTILE_TARGET,
    )

    np.testing.assert_allclose(board_target, np.full(4, 0.5))
    np.testing.assert_allclose(global_target, np.asarray([0, 1 / 3, 2 / 3, 1]))


def test_ranking_model_reports_time_ordered_full_cross_section_metrics():
    rng = np.random.default_rng(97240)
    unique_dates = np.arange(20200101, 20200201)
    dates = np.repeat(unique_dates, 20).astype(np.int32)
    rows = len(dates)
    x = rng.normal(size=(rows, len(MODEL_FEATURE_NAMES))).astype(np.float32)
    boards = np.tile(np.repeat(np.arange(4), 5), len(unique_dates)).astype(np.int8)
    target_return = (
        x[:, 0] * 0.03 + x[:, 1] * 0.01 + rng.normal(scale=0.01, size=rows)
    ).astype(np.float32)
    target_rank = np.empty(rows, dtype=np.float32)
    for offset in range(0, rows, 20):
        for board in range(4):
            indexes = np.arange(offset + board * 5, offset + (board + 1) * 5)
            order = np.argsort(np.argsort(target_return[indexes]))
            target_rank[indexes] = order / 4
    data = RankingTrainingData(
        x=x,
        dates=dates,
        boards=boards,
        instruments=np.asarray([b"SZ.000001"] * rows, dtype="S9"),
        target_return=target_return,
        target_rank=target_rank,
        sample_weight=np.full(rows, 1 / 20, dtype=np.float32),
    )

    models, metrics = train_ranking_models(
        data,
        max_iter=10,
        min_samples_leaf=10,
    )

    assert set(models) == {"rank", "expectedGrossReturn"}
    assert metrics["confirmationSamples"] > 0
    assert metrics["backtest"]["dates"] > 0
    assert metrics["backtest"]["selectedTrades"] > 0
    assert metrics["backtest"]["meanDailyRankIc"] > 0
    assert metrics["rankingTargetPolicy"] == BOARD_PERCENTILE_TARGET

    listwise_models, listwise_metrics = train_ranking_models(
        data,
        max_iter=10,
        min_samples_leaf=10,
        model_family=LAMBDARANK_MODEL_FAMILY,
        relevance_levels=100,
    )

    assert set(listwise_models) == {"rank", "expectedGrossReturn"}
    assert listwise_metrics["modelFamily"] == LAMBDARANK_MODEL_FAMILY
    assert listwise_metrics["relevanceLevels"] == 100
    assert listwise_metrics["backtest"]["selectedTrades"] > 0

    with pytest.raises(
        QuantModelError,
        match="RANKING_RELEVANCE_LEVELS_REQUIRE_LAMBDARANK",
    ):
        train_ranking_models(data, relevance_levels=20)


def test_ranking_bundle_records_lambdarank_relevance_levels(tmp_path, monkeypatch):
    data = RankingTrainingData(
        x=np.zeros((1, len(MODEL_FEATURE_NAMES)), dtype=np.float32),
        dates=np.asarray([20200101], dtype=np.int32),
        boards=np.asarray([0], dtype=np.int8),
        instruments=np.asarray([b"SH.600000"], dtype="S9"),
        target_return=np.asarray([0], dtype=np.float32),
        target_rank=np.asarray([0.5], dtype=np.float32),
        sample_weight=np.asarray([1], dtype=np.float32),
        target_policy=GLOBAL_PERCENTILE_TARGET,
    )

    def fake_train(*_args, **kwargs):
        assert kwargs["relevance_levels"] == 20
        return {"rank": None, "expectedGrossReturn": None}, {
            "relevanceLevels": 20,
            "labelGainPolicy": "linear-v1",
        }

    monkeypatch.setattr(ranking_model_trainer, "train_ranking_models", fake_train)
    manifest = write_ranking_bundle(
        output_root=tmp_path / "bundle",
        bundle_id="test-ranking",
        data=data,
        ranking_manifest={
            "datasetId": "test-dataset",
            "databaseSha256": "abc",
        },
        model_family=LAMBDARANK_MODEL_FAMILY,
        relevance_levels=20,
    )

    assert manifest["relevanceLevels"] == 20
    assert manifest["labelGainPolicy"] == "linear-v1"
    assert manifest["metrics"]["relevanceLevels"] == 20
