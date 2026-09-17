import hashlib
import json
import sqlite3
from datetime import date, timedelta
from decimal import Decimal

import pytest

from platform_app.modules.experiments.cash_equity_fees import (
    calculate_cash_equity_fees,
)
from platform_app.modules.experiments.foundation_market_cap_dataset import (
    FoundationMarketCapDataset,
    FoundationMarketCapDatasetError,
    verify_foundation_market_cap_dataset,
)
from platform_app.modules.experiments.foundation_experiment_factory import (
    freeze_registered_experiment,
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
from platform_app.modules.experiments.foundation_sampling_dataset import (
    FoundationSamplingDataset,
    FoundationSamplingDatasetError,
    allocate_daily_quotas,
    select_stratified_training_rows,
    verify_foundation_sampling_dataset,
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
        alias = {
            "sourceCode": "000042.SZ",
            "instrumentId": "SZ.000002",
            "effectiveFrom": dates[0],
            "effectiveTo": "20260101",
            "reason": "SECURITY_CODE_CHANGE",
            "source": "SYNTHETIC",
            "availableAt": "2025-06-30T16:30:00+08:00",
        }
        alias["sourceRowSha256"] = canonical_sha256(alias)
        market.write_aliases([alias])
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


def test_verification_rejects_tampered_virtual_manifest(
    tmp_path,
    sealed_sources,
):
    root, _manifest = _seal_foundation(tmp_path, sealed_sources)
    path = root / "data-manifest.json"
    payload = json.loads(path.read_text())
    payload["referenceSamples"] += 1
    path.write_text(json.dumps(payload))

    with pytest.raises(
        FoundationReturnDatasetError,
        match="FOUNDATION_DATASET_MANIFEST_MISMATCH",
    ):
        verify_foundation_return_dataset(root)


def _daily_basic_rows(trade_date, index):
    rows = []
    for code, base in (
        ("000001.SZ", Decimal("10")),
        ("000042.SZ", Decimal("20")),
        ("000002.SZ", Decimal("20")),
    ):
        close = base + Decimal(index) / 100
        rows.append(
            {
                "ts_code": code,
                "trade_date": trade_date,
                "close": str(close),
                "total_share": "100",
                "float_share": "80",
                "total_mv": str(close * 100),
                "circ_mv": str(close * 80),
            }
        )
    return rows


def test_market_cap_dataset_is_resumable_and_covers_reference_samples(
    tmp_path,
    sealed_sources,
):
    market_root, ranking_root, _labels_root, dates = sealed_sources
    foundation_root, foundation_manifest = _seal_foundation(
        tmp_path,
        sealed_sources,
    )
    root = tmp_path / "market-cap"
    kwargs = {
        "dataset_id": "market-cap-v1",
        "foundation_dataset_root": foundation_root,
        "ranking_dataset_root": ranking_root,
        "market_dataset_root": market_root,
    }
    with FoundationMarketCapDataset(root, **kwargs) as dataset:
        pending = dataset.pending_dates()
        first = dataset.ingest_partition(
            pending[0],
            _daily_basic_rows(pending[0], dates.index(pending[0])),
        )
        repeated = dataset.ingest_partition(
            pending[0],
            _daily_basic_rows(pending[0], dates.index(pending[0])),
        )
        assert first["acceptedCount"] == 2
        assert repeated["status"] == "SKIPPED"

    with FoundationMarketCapDataset(root, **kwargs) as dataset:
        for trade_date in dataset.pending_dates():
            dataset.ingest_partition(
                trade_date,
                _daily_basic_rows(trade_date, dates.index(trade_date)),
            )
        manifest = dataset.seal()

    assert manifest["partitions"] == foundation_manifest["decisionDates"]
    assert manifest["rows"] == foundation_manifest["referenceSamples"]
    assert manifest["rowsByBoard"] == {"MAIN": 90}
    assert manifest["startDate"] == foundation_manifest["startDate"]
    assert manifest["endDate"] == foundation_manifest["endDate"]
    with sqlite3.connect(root / "market-cap.sqlite3") as database:
        row = database.execute(
            "SELECT total_shares, float_shares, total_market_cap_cny, "
            "float_market_cap_cny, effective_at, published_at, as_of "
            "FROM market_cap_rows ORDER BY decision_date, instrument_id LIMIT 1",
        ).fetchone()
    assert row[0:2] == ("1000000", "800000")
    assert Decimal(row[2]) == Decimal("1000000") * Decimal(
        _daily_basic_rows(manifest["startDate"], dates.index(manifest["startDate"]))[
            0
        ]["close"]
    )
    assert Decimal(row[3]) == Decimal(row[2]) * Decimal("0.8")
    assert row[4].endswith("T15:00:00+08:00")
    assert row[5].endswith("T18:00:00+08:00")
    assert row[6] == row[5]


def test_market_cap_partition_rejects_missing_and_flags_source_anomaly(
    tmp_path,
    sealed_sources,
):
    market_root, ranking_root, _labels_root, dates = sealed_sources
    foundation_root, _manifest = _seal_foundation(tmp_path, sealed_sources)
    root = tmp_path / "market-cap"
    with FoundationMarketCapDataset(
        root,
        dataset_id="market-cap-v1",
        foundation_dataset_root=foundation_root,
        ranking_dataset_root=ranking_root,
        market_dataset_root=market_root,
    ) as dataset:
        trade_date = dataset.pending_dates()[0]
        rows = _daily_basic_rows(trade_date, dates.index(trade_date))
        with pytest.raises(
            FoundationMarketCapDatasetError,
            match="MARKET_CAP_PARTITION_COVERAGE_INCOMPLETE",
        ):
            dataset.ingest_partition(trade_date, rows[:1])

        invalid = _daily_basic_rows(trade_date, dates.index(trade_date))
        invalid[0]["float_share"] = "101"
        invalid[0]["circ_mv"] = str(
            Decimal(invalid[0]["close"]) * Decimal("101")
        )
        completed = dataset.ingest_partition(trade_date, invalid)
        flags = [
            row["flag"]
            for row in dataset.db.execute(
                "SELECT flag FROM market_cap_quality_flags",
            )
        ]

        assert completed["status"] == "COMPLETED"
        assert flags == ["SOURCE_FLOAT_EXCEEDS_TOTAL"]

        next_date = dataset.pending_dates()[0]
        mismatched = _daily_basic_rows(
            next_date,
            dates.index(next_date),
        )
        mismatched[0]["circ_mv"] = str(
            Decimal(mismatched[0]["circ_mv"]) * Decimal("1.03")
        )
        dataset.ingest_partition(next_date, mismatched)
        mismatch_flags = [
            row["flag"]
            for row in dataset.db.execute(
                "SELECT flag FROM market_cap_quality_flags "
                "WHERE decision_date = ?",
                (next_date,),
            )
        ]
        assert mismatch_flags == [
            "SOURCE_FLOAT_VALUE_RECONCILIATION_MISMATCH"
        ]

        next_date = dataset.pending_dates()[0]
        invalid_number = _daily_basic_rows(
            next_date,
            dates.index(next_date),
        )
        invalid_number[0]["total_mv"] = "-1"
        with pytest.raises(
            FoundationMarketCapDatasetError,
            match="MARKET_CAP_TOTAL_VALUE_INVALID",
        ):
            dataset.ingest_partition(next_date, invalid_number)

        with pytest.raises(
            FoundationMarketCapDatasetError,
            match="MARKET_CAP_PARTITIONS_INCOMPLETE",
        ):
            dataset.seal()


def test_market_cap_parallel_build_commits_each_completed_partition(
    tmp_path,
    sealed_sources,
):
    market_root, ranking_root, _labels_root, dates = sealed_sources
    foundation_root, _manifest = _seal_foundation(tmp_path, sealed_sources)

    class FakeClient:
        def rows(self, api_name, params, fields):
            assert api_name == "daily_basic"
            assert "total_mv" in fields
            trade_date = params["trade_date"]
            return _daily_basic_rows(trade_date, dates.index(trade_date))

    root = tmp_path / "parallel-market-cap"
    with FoundationMarketCapDataset(
        root,
        dataset_id="parallel-market-cap-v1",
        foundation_dataset_root=foundation_root,
        ranking_dataset_root=ranking_root,
        market_dataset_root=market_root,
    ) as dataset:
        results = list(
            dataset.build(
                FakeClient(),
                maximum_partitions=4,
                workers=2,
            )
        )
        stored = dataset.db.execute(
            "SELECT COUNT(*) FROM market_cap_partitions",
        ).fetchone()[0]

    assert len(results) == 4
    assert stored == 4
    assert all(result["status"] == "COMPLETED" for result in results)


def _seal_market_cap(tmp_path, sealed_sources, foundation_root):
    market_root, ranking_root, _labels_root, dates = sealed_sources
    root = tmp_path / "market-cap"
    with FoundationMarketCapDataset(
        root,
        dataset_id="market-cap-v1",
        foundation_dataset_root=foundation_root,
        ranking_dataset_root=ranking_root,
        market_dataset_root=market_root,
    ) as dataset:
        for trade_date in dataset.pending_dates():
            dataset.ingest_partition(
                trade_date,
                _daily_basic_rows(trade_date, dates.index(trade_date)),
            )
        dataset.seal()
    return root


def _seal_sampling(tmp_path, sealed_sources, foundation_root, market_cap_root):
    _market_root, ranking_root, _labels_root, _dates = sealed_sources
    with sqlite3.connect(ranking_root / "ranking.sqlite3") as database:
        decision_dates = [
            row[0]
            for row in database.execute(
                "SELECT DISTINCT decision_date FROM ranking_samples "
                "ORDER BY decision_date",
            )
        ]
    folds = build_foundation_walk_forward_splits(
        decision_dates,
        probability_calibration_sessions=2,
        conformal_calibration_sessions=2,
        purge_sessions=5,
        embargo_sessions=5,
        test_sessions=3,
    )
    root = tmp_path / "sampling"
    with FoundationSamplingDataset(
        root,
        dataset_id="sampling-v1",
        foundation_dataset_root=foundation_root,
        ranking_dataset_root=ranking_root,
        market_cap_dataset_root=market_cap_root,
        maximum_windows_per_fold=80,
        sampling_seed=17,
        folds=folds,
    ) as dataset:
        list(dataset.build())
        manifest = dataset.seal()
    return root, manifest


def test_stratified_selection_is_deterministic_and_weighted():
    rows = []
    for index in range(20):
        rows.append(
            {
                "instrument_id": f"SZ.{index:06d}",
                "board": "MAIN" if index < 10 else "CHINEXT",
                "execution_date": "20250102",
                "terminal_date": "20250108",
                "median_amount_20_cny": str(1000 + index * 100),
                "forward_return_next_open_5": (
                    "0.02" if index % 2 else "-0.02"
                ),
                "total_market_cap_cny": str(1_000_000 + index * 10_000),
            }
        )

    selected, strata = select_stratified_training_rows(
        rows,
        fold=1,
        decision_date="20250101",
        quota=12,
        sampling_seed=17,
    )
    repeated, repeated_strata = select_stratified_training_rows(
        list(reversed(rows)),
        fold=1,
        decision_date="20250101",
        quota=12,
        sampling_seed=17,
    )

    assert selected == repeated
    assert strata == repeated_strata
    assert len(selected) == 12
    assert {row["board"] for row in strata} == {"MAIN", "CHINEXT"}
    assert {row["outcomeBucket"] for row in strata} == {"LOSS", "NON_LOSS"}
    for stratum in strata:
        probability = Decimal(stratum["samplingProbability"])
        weight = Decimal(stratum["inverseProbabilityWeight"])
        assert probability * weight == 1
    with pytest.raises(
        FoundationSamplingDatasetError,
        match="FOUNDATION_SAMPLING_STRATA_SUPPORT_INSUFFICIENT",
    ):
        select_stratified_training_rows(
            rows,
            fold=1,
            decision_date="20250101",
            quota=1,
            sampling_seed=17,
        )


def test_sampling_dataset_keeps_full_evaluation_and_all_training_dates(
    tmp_path,
    sealed_sources,
):
    _market_root, ranking_root, _labels_root, _dates = sealed_sources
    foundation_root, _manifest = _seal_foundation(tmp_path, sealed_sources)
    market_cap_root = _seal_market_cap(
        tmp_path,
        sealed_sources,
        foundation_root,
    )
    sampling_root, manifest = _seal_sampling(
        tmp_path,
        sealed_sources,
        foundation_root,
        market_cap_root,
    )
    folds = manifest["folds"]

    assert len(manifest["folds"]) == 5
    assert manifest["fullUniverseEvaluation"] is True
    assert all(fold["trainSelected"] <= 80 for fold in manifest["folds"])
    assert all(fold["testRows"] == 6 for fold in manifest["folds"])
    assert all(
        fold["trainingSelection"] == "DETERMINISTIC_STRATIFIED_SAMPLE"
        and fold["testSelection"] == "FULL_UNIVERSE"
        for fold in manifest["folds"]
    )
    with sqlite3.connect(sampling_root / "sampling.sqlite3") as database:
        per_fold = database.execute(
            "SELECT fold, COUNT(DISTINCT decision_date), COUNT(*) "
            "FROM training_samples GROUP BY fold ORDER BY fold",
        ).fetchall()
        leakage = database.execute(
            "SELECT COUNT(*) FROM training_samples s "
            "JOIN sampling_dataset_metadata m ON m.singleton = 1 "
            "WHERE EXISTS ("
            "SELECT 1 FROM json_each(m.folds_json) f "
            "WHERE CAST(json_extract(f.value, '$.fold') AS INTEGER) = s.fold "
            "AND s.decision_date > json_extract(f.value, '$.trainEnd')"
            ")",
        ).fetchone()[0]
    assert [row[1] for row in per_fold] == [
        fold["trainSessions"] for fold in folds
    ]
    assert leakage == 0


def test_registered_experiment_freezes_real_artifact_hashes(
    tmp_path,
    sealed_sources,
):
    _market_root, _ranking_root, _labels_root, _dates = sealed_sources
    foundation_root, foundation = _seal_foundation(tmp_path, sealed_sources)
    market_cap_root = _seal_market_cap(
        tmp_path,
        sealed_sources,
        foundation_root,
    )
    sampling_root, sampling = _seal_sampling(
        tmp_path,
        sealed_sources,
        foundation_root,
        market_cap_root,
    )
    output = tmp_path / "experiment"

    frozen = freeze_registered_experiment(
        output,
        foundation_dataset_root=foundation_root,
        market_cap_dataset_root=market_cap_root,
        sampling_dataset_root=sampling_root,
    )
    repeated = freeze_registered_experiment(
        output,
        foundation_dataset_root=foundation_root,
        market_cap_dataset_root=market_cap_root,
        sampling_dataset_root=sampling_root,
    )

    dataset = frozen["configuration"]["dataset"]
    assert frozen == repeated
    assert frozen["releaseStatus"] == "UNAVAILABLE"
    assert dataset["databaseSha256"] == foundation["databaseSha256"]
    assert dataset["samplingDatabaseSha256"] == sampling["databaseSha256"]
    assert dataset["historySessions"] == 90
    assert frozen["configuration"]["training"]["finalConfirmationFold"] == 5
    assert frozen["configuration"]["releasePolicy"][
        "allowProductionPointerUpdate"
    ] is False
    assert (
        frozen["configuration"]["models"][0]["revision"]
        == "cd2ad2a54ba5531fbcf6ba3b7a763a6e14223680"
    )
    assert (output / "experiment.json").is_file()
    assert (output / "model-sources.json").is_file()


def test_market_cap_and_sampling_manifests_reject_metadata_drift(
    tmp_path,
    sealed_sources,
):
    foundation_root, _foundation = _seal_foundation(tmp_path, sealed_sources)
    market_cap_root = _seal_market_cap(
        tmp_path,
        sealed_sources,
        foundation_root,
    )
    sampling_root, _sampling = _seal_sampling(
        tmp_path,
        sealed_sources,
        foundation_root,
        market_cap_root,
    )
    market_cap_path = market_cap_root / "market-cap-manifest.json"
    market_cap_payload = json.loads(market_cap_path.read_text())
    market_cap_payload["rows"] += 1
    market_cap_path.write_text(json.dumps(market_cap_payload))
    with pytest.raises(
        FoundationMarketCapDatasetError,
        match="MARKET_CAP_DATASET_MANIFEST_MISMATCH",
    ):
        verify_foundation_market_cap_dataset(market_cap_root)

    sampling_path = sampling_root / "split-manifest.json"
    sampling_payload = json.loads(sampling_path.read_text())
    sampling_payload["folds"][0]["trainEnd"] = "19000101"
    sampling_path.write_text(json.dumps(sampling_payload))
    with pytest.raises(
        FoundationSamplingDatasetError,
        match="FOUNDATION_SAMPLING_MANIFEST_MISMATCH",
    ):
        verify_foundation_sampling_dataset(sampling_root)


def test_daily_quota_requires_at_least_one_sample_per_training_date():
    with pytest.raises(
        FoundationSamplingDatasetError,
        match="FOUNDATION_DAILY_QUOTA_INPUT_INVALID",
    ):
        allocate_daily_quotas(
            {"20250101": 10, "20250102": 10},
            maximum_windows=1,
        )
