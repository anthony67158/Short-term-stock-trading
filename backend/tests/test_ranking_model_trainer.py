import numpy as np

from platform_app.modules.experiments.ranking_model_trainer import (
    MODEL_FEATURE_NAMES,
    RankingTrainingData,
    train_ranking_models,
)


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
