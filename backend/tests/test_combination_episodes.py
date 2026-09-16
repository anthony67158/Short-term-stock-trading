import json
import sqlite3

import pytest

from platform_app.modules.experiments.combination_episodes import build_candidates, union_policy
from platform_app.modules.experiments.episode_dataset import EpisodeDataset, EpisodeDatasetError
from platform_app.modules.experiments.market_dataset import MarketDataset
from platform_app.modules.experiments.ranking_model_trainer import RAW_COLUMNS


def test_union_builds_once_without_using_future_returns(tmp_path):
    market = tmp_path / "market"
    with MarketDataset(market, dataset_id="synthetic", source="TUSHARE_COMPATIBLE") as dataset:
        dataset.seal()
    experiment = tmp_path / "experiment"
    fold = experiment / "fold-1"
    fold.mkdir(parents=True)
    (experiment / "protocol.json").write_text(json.dumps({"databaseSha256": "a" * 64}))
    (fold / "evaluation.json").write_text(json.dumps({
        "split": {"testStart": "20250102", "testEnd": "20250103"},
    }))
    (fold / "candidate-union.json").write_text(json.dumps({"candidates": [
        {"decisionDate": "20250102", "instrumentId": "SH.600001", "selectedBy": ["rank5"]},
        {"decisionDate": "20250102", "instrumentId": "SZ.300001", "selectedBy": ["return"]},
    ]}))
    ranking = tmp_path / "ranking.sqlite3"
    with sqlite3.connect(ranking) as db:
        db.execute(
            "CREATE TABLE ranking_samples (instrument_id TEXT, board TEXT, decision_date TEXT,"
            "execution_date TEXT, feature_available_at TEXT,"
            + ",".join(f"{column} TEXT" for column in RAW_COLUMNS) + ")"
        )
        for instrument, board in [
            ("SH.600001", "MAIN"), ("SZ.300001", "CHINEXT"), ("BJ.920001", "BEIJING"),
        ]:
            values = [instrument, board, "20250102", "20250103",
                      "2025-01-02T08:30:00Z", *(["1"] * len(RAW_COLUMNS))]
            db.execute(
                "INSERT INTO ranking_samples VALUES (" + ",".join("?" * len(values)) + ")",
                values,
            )
    policy = union_policy(experiment, {"databaseSha256": "a" * 64, "datasetId": "ranking"})
    with EpisodeDataset(
        tmp_path / "episodes", dataset_id="union", market_dataset_root=market, policy=policy,
    ) as dataset:
        build_candidates(dataset, experiment, ranking)
        build_candidates(dataset, experiment, ranking)
        rows = dataset.db.execute(
            "SELECT instrument_id,sample_bucket FROM candidate_episodes ORDER BY instrument_id"
        ).fetchall()
        assert [tuple(row) for row in rows] == [
            ("SH.600001", "COMBINATION_OOF_UNION"), ("SZ.300001", "COMBINATION_OOF_UNION"),
        ]
        assert dataset.db.execute(
            "SELECT universe_count FROM candidate_partitions"
        ).fetchone()[0] == 3
        (fold / "evaluation.json").write_text(json.dumps({
            "split": {"testStart": "20260101", "testEnd": "20260131"},
        }))
        with pytest.raises(EpisodeDatasetError, match="SELECTION_OUTSIDE_TEST"):
            build_candidates(dataset, experiment, ranking)


def test_union_refuses_wrong_ranking_lineage(tmp_path):
    (tmp_path / "protocol.json").write_text(json.dumps({"databaseSha256": "a" * 64}))
    with pytest.raises(EpisodeDatasetError, match="LINEAGE_MISMATCH"):
        union_policy(tmp_path, {"databaseSha256": "b" * 64})
