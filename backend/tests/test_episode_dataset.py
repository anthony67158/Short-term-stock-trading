import hashlib
import sqlite3

import pytest

from platform_app.modules.experiments.episode_dataset import (
    EpisodeDataset,
    EpisodeDatasetError,
)
from platform_app.modules.experiments.market_dataset import MarketDataset


def policy(**changes):
    value = {
        "policyVersion": "short-horizon.v1",
        "featureSchemaVersion": "candidate-features.v1",
        "candidatePolicy": {"quotaPerBoard": 25, "minimumHistorySessions": 61},
        "executionPolicy": {"entry": "NEXT_SESSION_FIRST_30_MINUTES"},
        "horizon": {"tradingSessions": 5},
        "labelPolicy": {"sameBarConflict": "STOP_FIRST"},
        "releasePolicy": {"stressCostBps": 10, "minimumNetRLowerBound": "0.02"},
    }
    value.update(changes)
    return value


def sealed_market_dataset(tmp_path):
    root = tmp_path / "market"
    with MarketDataset(
        root,
        dataset_id="canonical-market",
        source="TUSHARE_COMPATIBLE",
    ) as dataset:
        manifest = dataset.seal()
    return root, manifest


def candidate(**changes):
    value = {
        "instrumentId": "SZ.000001",
        "board": "MAIN",
        "rankWithinBoard": 1,
        "sampleBucket": "LIQUIDITY_TOP",
        "featureAvailableAt": "2026-09-15T16:30:00+08:00",
        "featureSchemaVersion": "candidate-features.v1",
        "features": {
            "adjustedReturn20": "0.052",
            "medianAmount20Cny": "100000000",
        },
        "selectionScore": "1.25",
    }
    value.update(changes)
    return value


def test_episode_dataset_binds_verified_market_hash_and_replays_exact_partition(tmp_path):
    market_root, market_manifest = sealed_market_dataset(tmp_path)
    root = tmp_path / "episodes"
    kwargs = {
        "decision_date": "20260915",
        "execution_date": "20260916",
        "universe_count": 5000,
        "universe_sha256": hashlib.sha256(b"universe").hexdigest(),
        "candidates": [candidate()],
        "rejections": [{"board": "MAIN", "reason": "INSUFFICIENT_HISTORY", "instrumentCount": 2}],
    }

    with EpisodeDataset(
        root,
        dataset_id="short-horizon-training-v1",
        market_dataset_root=market_root,
        policy=policy(),
    ) as dataset:
        assert dataset.write_candidate_partition(**kwargs)
        assert not dataset.write_candidate_partition(**kwargs)
        assert dataset.has_candidate_partition("20260915")
        metadata = dataset.db.execute(
            "SELECT market_database_sha256, policy_sha256 FROM episode_dataset_metadata"
        ).fetchone()
        assert metadata["market_database_sha256"] == market_manifest["databaseSha256"]
        assert len(metadata["policy_sha256"]) == 64

    with sqlite3.connect(root / "episodes.sqlite3") as database:
        assert database.execute("SELECT COUNT(*) FROM candidate_episodes").fetchone()[0] == 1
        assert (
            database.execute(
                "SELECT instrument_count FROM candidate_partition_rejections"
            ).fetchone()[0]
            == 2
        )


def test_candidate_partition_conflict_is_rejected_without_partial_rows(tmp_path):
    market_root, _ = sealed_market_dataset(tmp_path)
    root = tmp_path / "episodes"
    with EpisodeDataset(
        root,
        dataset_id="short-horizon-training-v1",
        market_dataset_root=market_root,
        policy=policy(),
    ) as dataset:
        universe_hash = hashlib.sha256(b"universe").hexdigest()
        dataset.write_candidate_partition(
            decision_date="20260915",
            execution_date="20260916",
            universe_count=1,
            universe_sha256=universe_hash,
            candidates=[candidate()],
            rejections=[],
        )
        with pytest.raises(EpisodeDatasetError, match="CANDIDATE_PARTITION_CONFLICT"):
            dataset.write_candidate_partition(
                decision_date="20260915",
                execution_date="20260916",
                universe_count=1,
                universe_sha256=universe_hash,
                candidates=[candidate(selectionScore="9")],
                rejections=[],
            )
        assert dataset.db.execute("SELECT COUNT(*) FROM candidate_episodes").fetchone()[0] == 1


def test_episode_dataset_rejects_market_tampering_and_policy_drift(tmp_path):
    market_root, _ = sealed_market_dataset(tmp_path)
    database_path = market_root / "market.sqlite3"
    database_path.write_bytes(database_path.read_bytes() + b"tampered")
    with pytest.raises(EpisodeDatasetError, match="MARKET_DATABASE_HASH_MISMATCH"):
        EpisodeDataset(
            tmp_path / "episodes",
            dataset_id="short-horizon-training-v1",
            market_dataset_root=market_root,
            policy=policy(),
        )

    clean_market_root, _ = sealed_market_dataset(tmp_path / "clean")
    root = tmp_path / "policy-drift"
    with EpisodeDataset(
        root,
        dataset_id="short-horizon-training-v1",
        market_dataset_root=clean_market_root,
        policy=policy(),
    ):
        pass
    with pytest.raises(EpisodeDatasetError, match="EPISODE_DATASET_IDENTITY_MISMATCH"):
        EpisodeDataset(
            root,
            dataset_id="short-horizon-training-v1",
            market_dataset_root=clean_market_root,
            policy=policy(horizon={"tradingSessions": 10}),
        )


def test_sealed_episode_dataset_has_verifiable_hash_and_is_immutable(tmp_path):
    market_root, market_manifest = sealed_market_dataset(tmp_path)
    root = tmp_path / "episodes"
    with EpisodeDataset(
        root,
        dataset_id="short-horizon-training-v1",
        market_dataset_root=market_root,
        policy=policy(),
    ) as dataset:
        manifest = dataset.seal()

    assert manifest["marketDatabaseSha256"] == market_manifest["databaseSha256"]
    assert (
        manifest["databaseSha256"]
        == hashlib.sha256((root / "episodes.sqlite3").read_bytes()).hexdigest()
    )
    with pytest.raises(EpisodeDatasetError, match="EPISODE_DATASET_ALREADY_SEALED"):
        EpisodeDataset(
            root,
            dataset_id="short-horizon-training-v1",
            market_dataset_root=market_root,
            policy=policy(),
        )


def test_unsealed_v1_dataset_migrates_without_rebuilding_candidates(tmp_path):
    market_root, _ = sealed_market_dataset(tmp_path)
    root = tmp_path / "episodes"
    with EpisodeDataset(
        root,
        dataset_id="short-horizon-training-v1",
        market_dataset_root=market_root,
        policy=policy(),
    ) as dataset:
        dataset.write_candidate_partition(
            decision_date="20260915",
            execution_date="20260916",
            universe_count=1,
            universe_sha256=hashlib.sha256(b"universe").hexdigest(),
            candidates=[candidate()],
            rejections=[],
        )
        dataset.db.execute(
            "UPDATE episode_dataset_metadata SET schema_version = 'episode-dataset.v1'"
        )
        dataset.db.commit()

    with EpisodeDataset(
        root,
        dataset_id="short-horizon-training-v1",
        market_dataset_root=market_root,
        policy=policy(),
    ) as migrated:
        assert (
            migrated.db.execute("SELECT schema_version FROM episode_dataset_metadata").fetchone()[0]
            == "episode-dataset.v2"
        )
        assert migrated.db.execute("SELECT COUNT(*) FROM candidate_episodes").fetchone()[0] == 1
