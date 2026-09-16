import pytest

from platform_app.modules.experiments.episode_dataset import EpisodeDatasetError
from platform_app.modules.experiments.ranking_model_trainer import RAW_COLUMNS
from platform_app.modules.experiments.selected_episode_builder import (
    _partition_payload,
    selected_backtest_policy,
)


def _ranking_row(instrument_id, board, execution_date="20250103"):
    row = {
        "instrument_id": instrument_id,
        "board": board,
        "execution_date": execution_date,
        "feature_available_at": "2025-01-02T08:30:00+00:00",
    }
    row.update({column: str(index + 1) for index, column in enumerate(RAW_COLUMNS)})
    return row


def test_selected_backtest_policy_binds_exact_ranking_artifacts():
    policy = selected_backtest_policy(
        ranking_manifest={
            "datasetId": "ranking-v1",
            "databaseSha256": "a" * 64,
        },
        ranking_model_manifest={
            "bundleId": "rank-model-v1",
            "artifactSha256": "b" * 64,
            "rankingDatabaseSha256": "a" * 64,
        },
        top_n=10,
    )

    assert policy["policyVersion"] == "full-universe-selected-backtest.v1"
    assert policy["candidatePolicy"]["dailyTopN"] == 10
    assert policy["candidatePolicy"]["rankingModelArtifactSha256"] == "b" * 64
    assert policy["featureSchemaVersion"] == "daily-ranking-features.v1"

    with pytest.raises(EpisodeDatasetError, match="SELECTED_BACKTEST_LINEAGE_INVALID"):
        selected_backtest_policy(
            ranking_manifest={
                "datasetId": "ranking-v1",
                "databaseSha256": "a" * 64,
            },
            ranking_model_manifest={
                "bundleId": "rank-model-v1",
                "artifactSha256": "b" * 64,
                "rankingDatabaseSha256": "c" * 64,
            },
            top_n=10,
        )


def test_partition_payload_preserves_full_universe_and_board_ranks():
    universe = [
        _ranking_row("BJ.920001", "BEIJING"),
        _ranking_row("SH.600001", "MAIN"),
        _ranking_row("SH.600002", "MAIN"),
        _ranking_row("SZ.300001", "CHINEXT"),
    ]
    selections = [
        {
            "instrumentId": "SH.600002",
            "rankPosition": 1,
            "rankScore": 0.9,
        },
        {
            "instrumentId": "BJ.920001",
            "rankPosition": 2,
            "rankScore": 0.8,
        },
        {
            "instrumentId": "SH.600001",
            "rankPosition": 3,
            "rankScore": 0.7,
        },
    ]

    payload = _partition_payload(
        decision_date="20250102",
        selections=selections,
        universe_rows=universe,
        feature_schema_version="daily-ranking-features.v1",
    )

    assert payload["universe_count"] == 4
    assert payload["execution_date"] == "20250103"
    assert [row["instrumentId"] for row in payload["candidates"]] == [
        "SH.600002",
        "BJ.920001",
        "SH.600001",
    ]
    assert [row["rankWithinBoard"] for row in payload["candidates"]] == [1, 1, 2]
    assert payload["candidates"][0]["features"]["medianAmount20Cny"] == "12"
    assert payload["rejections"] == [
        {
            "board": "CHINEXT",
            "reason": "NOT_SELECTED_BY_MODEL_TOP_N",
            "instrumentCount": 1,
        }
    ]
