import hashlib
import json
import sqlite3
from datetime import date, timedelta
from decimal import Decimal

import pytest

from platform_app.modules.experiments.cash_equity_fees import (
    calculate_cash_equity_fees,
)
from platform_app.modules.experiments.foundation_return_dataset import (
    FoundationReturnDataset,
    FoundationReturnDatasetError,
    FoundationReturnDatasetReader,
    build_foundation_walk_forward_splits,
    reference_full_fill_net_return,
    verify_foundation_return_dataset,
    walk_forward_partition,
)
from platform_app.modules.experiments.label_dataset import SCHEMA as LABEL_SCHEMA
from platform_app.modules.experiments.market_dataset import (
    MarketDataset,
    canonical_sha256,
)
from platform_app.modules.experiments.ranking_dataset import RankingDataset


def _file_sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _sealed_market(tmp_path):
    root = tmp_path / "market"
    dates = [
        (date(2025, 1, 1) + timedelta(days=offset)).strftime("%Y%m%d")
        for offset in range(110)
    ]
    instruments = [
        {
            "instrumentId": "SZ.000001",
            "sourceCode": "000001.SZ",
            "exchange": "SZ",
            "board": "MAIN",
            "name": "One",
            "listStatus": "L",
            "listDate": dates[0],
            "delistDate": None,
            "source": "SYNTHETIC",
            "availableAt": "2025-06-30T16:30:00+08:00",
        },
        {
            "instrumentId": "SZ.000002",
            "sourceCode": "000002.SZ",
            "exchange": "SZ",
            "board": "MAIN",
            "name": "Two",
            "listStatus": "L",
            "listDate": dates[0],
            "delistDate": None,
            "source": "SYNTHETIC",
            "availableAt": "2025-06-30T16:30:00+08:00",
        },
    ]
    for instrument in instruments:
        instrument["sourceRowSha256"] = canonical_sha256(instrument)
    with MarketDataset(root, dataset_id="market-v1", source="SYNTHETIC") as market:
        market.write_instruments(instruments)
        market.write_facts(
            "trade_calendar",
            [
                {
                    "exchange": "SSE",
                    "cal_date": trade_date,
                    "is_open": 1,
                    "previous_open_date": dates[index - 1] if index else None,
                    "source": "SYNTHETIC",
                    "available_at": "2025-06-30T16:30:00+08:00",
                    "source_row_sha256": canonical_sha256({"date": trade_date}),
                }
                for index, trade_date in enumerate(dates)
            ],
            key_fields=("exchange", "cal_date"),
        )
        daily = []
        factors = []
        for instrument_index, instrument in enumerate(instruments, 1):
            previous_close = Decimal(10 * instrument_index)
            for index, trade_date in enumerate(dates):
                close = Decimal(10 * instrument_index) + Decimal(index) / 100
                row = {
                    "instrumentId": instrument["instrumentId"],
                    "sourceCode": instrument["sourceCode"],
                    "tradeDate": trade_date,
                    "open": str(close),
                    "high": str(close + Decimal("0.10")),
                    "low": str(close - Decimal("0.10")),
                    "close": str(close),
                    "previousClose": str(previous_close),
                    "volumeShares": "100000",
                    "amountCny": "1000000",
                    "adjustment": "RAW",
                }
                row["sourceRowSha256"] = canonical_sha256(row)
                daily.append(row)
                factor = {
                    "instrument_id": instrument["instrumentId"],
                    "source_code": instrument["sourceCode"],
                    "trade_date": trade_date,
                    "factor": "2",
                    "source": "SYNTHETIC",
                    "available_at": "2025-06-30T16:30:00+08:00",
                }
                factor["source_row_sha256"] = canonical_sha256(factor)
                factors.append(factor)
                previous_close = close
        market.write_daily_bars(
            daily,
            source="SYNTHETIC",
            available_at="2025-06-30T16:30:00+08:00",
        )
        market.write_facts(
            "adjustment_factors",
            factors,
            key_fields=("instrument_id", "trade_date"),
        )
        market.seal()
    return root, dates


def _sealed_ranking(tmp_path, market_root, dates):
    root = tmp_path / "ranking"
    with RankingDataset(
        root,
        dataset_id="ranking-v1",
        market_dataset_root=market_root,
        start_date=dates[0],
        end_date=dates[-1],
    ) as dataset:
        list(dataset.build())
        dataset.seal()
    return root


def _sealed_execution_labels(tmp_path, market_root, dates):
    root = tmp_path / "labels"
    root.mkdir()
    database = root / "labels.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.executescript(LABEL_SCHEMA)
        rows = [
            (
                "episode-fill",
                dates[90],
                "SZ.000002",
                "MAIN",
                '["REFERENCE_100K"]',
                1,
                "1000000",
                "100000",
                "0.1",
                1,
                1,
                "1",
                10000,
                10000,
                10000,
                "10",
                "10.2",
                1,
                "0.018",
                0,
                "TERMINAL",
                dates[95],
                "5.1",
                "5.2",
                "1" * 64,
            ),
            (
                "episode-no-fill",
                dates[90],
                "SZ.000001",
                "MAIN",
                '["REFERENCE_100K"]',
                1,
                "1000000",
                "100000",
                "0.1",
                0,
                0,
                "0",
                0,
                0,
                10000,
                "10",
                None,
                None,
                None,
                None,
                "NO_FILL",
                None,
                None,
                None,
                "2" * 64,
            ),
        ]
        connection.executemany(
            "INSERT INTO episode_labels VALUES "
            f"({','.join('?' for _ in range(25))})",
            rows,
        )
    market_manifest = json.loads((market_root / "manifest.json").read_text())
    manifest = {
        "datasetId": "execution-labels-v1",
        "schemaVersion": "label-dataset.v2",
        "database": database.name,
        "databaseSha256": _file_sha256(database),
        "episodeDatasetId": "synthetic-episodes-v1",
        "episodeDatabaseSha256": "3" * 64,
        "marketDatabaseSha256": market_manifest["databaseSha256"],
        "simulationPolicySha256": "4" * 64,
    }
    (root / "manifest.json").write_text(json.dumps(manifest))
    return root


@pytest.fixture
def sealed_sources(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    ranking_root = _sealed_ranking(tmp_path, market_root, dates)
    labels_root = _sealed_execution_labels(tmp_path, market_root, dates)
    return market_root, ranking_root, labels_root, dates


def _seal_foundation(tmp_path, sealed_sources):
    market_root, ranking_root, labels_root, _dates = sealed_sources
    root = tmp_path / "foundation"
    with FoundationReturnDataset(
        root,
        dataset_id="foundation-v1",
        ranking_dataset_root=ranking_root,
        market_dataset_root=market_root,
        execution_label_dataset_root=labels_root,
        history_sessions=90,
    ) as dataset:
        manifest = dataset.seal()
    return root, manifest


def test_virtual_dataset_seals_lineage_and_execution_coverage(
    tmp_path,
    sealed_sources,
):
    market_root, ranking_root, labels_root, _dates = sealed_sources
    root, manifest = _seal_foundation(tmp_path, sealed_sources)

    verified, database = verify_foundation_return_dataset(root)

    assert verified == manifest
    assert database.stat().st_size < 100_000
    assert manifest["storageMode"] == "VIRTUAL_SEALED_UPSTREAM_REFERENCES"
    assert manifest["historySessions"] == 90
    assert manifest["referenceSamples"] == 90
    assert manifest["instruments"] == 2
    assert manifest["decisionDates"] == 45
    assert manifest["rankingDataset"]["databaseSha256"] == json.loads(
        (ranking_root / "manifest.json").read_text()
    )["databaseSha256"]
    assert manifest["marketDataset"]["databaseSha256"] == json.loads(
        (market_root / "manifest.json").read_text()
    )["databaseSha256"]
    assert manifest["executionLabelDataset"]["databaseSha256"] == json.loads(
        (labels_root / "manifest.json").read_text()
    )["databaseSha256"]
    assert manifest["executionCoverage"] == {
        "coveredSamples": 2,
        "fillLabels": 1,
        "noFillLabels": 1,
        "conditionalReturnLabels": 1,
        "missingSemantics": "MISSING_NOT_ZERO",
    }


def test_reader_streams_exact_point_in_time_history(tmp_path, sealed_sources):
    market_root, ranking_root, labels_root, dates = sealed_sources
    root, _manifest = _seal_foundation(tmp_path, sealed_sources)

    with FoundationReturnDatasetReader(
        root,
        ranking_dataset_root=ranking_root,
        market_dataset_root=market_root,
        execution_label_dataset_root=labels_root,
    ) as reader:
        sequence = reader.load_history_sequence("SZ.000001", dates[90])

    assert sequence["historySessions"] == 90
    assert len(sequence["rows"]) == 90
    assert sequence["rows"][0]["tradeDate"] == dates[1]
    assert sequence["rows"][-1]["tradeDate"] == dates[90]
    assert all(row["tradeDate"] <= dates[90] for row in sequence["rows"])
    assert Decimal(sequence["rows"][-1]["adjustedClose"]) == (
        Decimal(sequence["rows"][-1]["close"]) * 2
    )
    assert sequence["featureAvailableAt"] == "2025-06-30T16:30:00+08:00"


def test_targets_separate_reference_return_from_execution_coverage(
    tmp_path,
    sealed_sources,
):
    market_root, ranking_root, labels_root, dates = sealed_sources
    root, _manifest = _seal_foundation(tmp_path, sealed_sources)

    with FoundationReturnDatasetReader(
        root,
        ranking_dataset_root=ranking_root,
        market_dataset_root=market_root,
        execution_label_dataset_root=labels_root,
    ) as reader:
        no_fill = reader.load_targets("SZ.000001", dates[90])
        missing = reader.load_targets("SZ.000001", dates[91])

    gross = Decimal(no_fill["referenceGrossReturn5d"])
    buy_fees = calculate_cash_equity_fees(
        side="BUY",
        gross_amount=Decimal("100000"),
        board="MAIN",
        trade_date=dates[91],
    )["totalCny"]
    sell_gross = Decimal("100000") * (1 + gross) * Decimal("0.9995")
    sell_fees = calculate_cash_equity_fees(
        side="SELL",
        gross_amount=sell_gross,
        board="MAIN",
        trade_date=dates[95],
    )["totalCny"]
    expected = (
        sell_gross - sell_fees - Decimal("100000") - buy_fees
    ) / (Decimal("100000") + buy_fees)

    assert Decimal(no_fill["referenceNetReturn5d"]) == expected
    assert no_fill["referenceTargetKind"] == "REFERENCE_FULL_FILL_FEE_ADJUSTED_5D"
    assert no_fill["execution"]["pFillLabel"] == 0
    assert no_fill["execution"]["fillRatioLabel"] == "0"
    assert no_fill["execution"]["netReturnGivenFill"] is None
    assert missing["execution"] is None


def test_reference_target_rejects_impossible_loss():
    with pytest.raises(
        FoundationReturnDatasetError,
        match="FOUNDATION_GROSS_RETURN_INVALID",
    ):
        reference_full_fill_net_return(
            gross_return="-1",
            board="MAIN",
            execution_date="20250102",
            terminal_date="20250108",
        )


def test_walk_forward_splits_preserve_date_groups_and_gaps():
    dates = [
        (date(2020, 1, 1) + timedelta(days=offset)).strftime("%Y%m%d")
        for offset in range(500)
    ]

    folds = build_foundation_walk_forward_splits(
        dates,
        test_sessions=63,
    )

    assert len(folds) == 5
    assert [fold["fold"] for fold in folds] == [1, 2, 3, 4, 5]
    assert all(fold["testSessions"] == 63 for fold in folds)
    assert all(fold["purgeSessions"] == 5 for fold in folds)
    assert all(fold["embargoSessions"] == 5 for fold in folds)
    assert all(
        previous["trainEnd"] < current["trainEnd"]
        and previous["testEnd"] < current["testStart"]
        for previous, current in zip(folds, folds[1:], strict=False)
    )
    for fold in folds:
        partitions = [walk_forward_partition(value, fold) for value in dates]
        assert partitions.count("PROBABILITY_CALIBRATION") == 63
        assert partitions.count("CONFORMAL_CALIBRATION") == 63
        assert partitions.count("TEST") == 63
        assert partitions.count("PURGE") == 5
        assert partitions.count("EMBARGO") == 5
        grouped = {
            partition: {
                value
                for value in dates
                if walk_forward_partition(value, fold) == partition
            }
            for partition in set(partitions)
        }
        assert sum(len(group) for group in grouped.values()) == len(dates)
        assert not any(
            left & right
            for index, left in enumerate(grouped.values())
            for right in list(grouped.values())[index + 1 :]
        )


def test_walk_forward_rejects_duplicate_or_insufficient_dates():
    dates = [
        (date(2020, 1, 1) + timedelta(days=offset)).strftime("%Y%m%d")
        for offset in range(450)
    ]
    with pytest.raises(
        FoundationReturnDatasetError,
        match="FOUNDATION_SPLIT_DATES_INVALID",
    ):
        build_foundation_walk_forward_splits([*dates, dates[-1]], test_sessions=63)
    with pytest.raises(
        FoundationReturnDatasetError,
        match="FOUNDATION_SPLIT_SUPPORT_INSUFFICIENT",
    ):
        build_foundation_walk_forward_splits(dates[:440], test_sessions=63)


def test_verification_rejects_tampered_virtual_database(
    tmp_path,
    sealed_sources,
):
    root, _manifest = _seal_foundation(tmp_path, sealed_sources)
    with (root / "foundation.sqlite3").open("ab") as stream:
        stream.write(b"tampered")

    with pytest.raises(
        FoundationReturnDatasetError,
        match="FOUNDATION_DATASET_INVALID",
    ):
        verify_foundation_return_dataset(root)
