import gzip
import hashlib
import json
from datetime import datetime, timedelta

import pytest

from platform_app.adapters.market_tushare import HistoricalMarketError
from platform_app.modules.experiments.episode_dataset import EpisodeDataset
from platform_app.modules.experiments.market_dataset import (
    MarketDataset,
    canonical_sha256,
)
from platform_app.modules.experiments.minute_archive_importer import (
    MinuteArchiveError,
    MinuteArchiveImporter,
    _validate_daily,
    reject_minute_requirement,
)
from platform_app.modules.experiments.minute_requirement_builder import (
    MinuteRequirementBuilder,
)
from platform_app.modules.experiments.minute_requirement_fetcher import (
    MinuteRequirementFetcher,
)
from platform_app.modules.experiments.short_horizon_policy import SHORT_HORIZON_POLICY


def _sealed_market(tmp_path):
    root = tmp_path / "market"
    dates = [f"2026010{day}" for day in range(1, 8)]
    with MarketDataset(
        root,
        dataset_id="minute-requirement-market",
        source="TUSHARE_COMPATIBLE",
    ) as market:
        instrument = {
            "instrumentId": "SZ.000001",
            "sourceCode": "000001.SZ",
            "exchange": "SZ",
            "board": "MAIN",
            "name": "Synthetic",
            "listStatus": "L",
            "listDate": "20200101",
            "delistDate": None,
            "source": "TUSHARE_COMPATIBLE",
            "availableAt": "2020-01-01T16:30:00+08:00",
        }
        instrument["sourceRowSha256"] = canonical_sha256(instrument)
        market.write_instruments([instrument])
        market.write_facts(
            "trade_calendar",
            [
                {
                    "exchange": "SSE",
                    "cal_date": trade_date,
                    "is_open": 1,
                    "previous_open_date": dates[index - 1] if index else None,
                    "source": "TUSHARE_COMPATIBLE",
                    "available_at": f"{trade_date}T16:30:00+08:00",
                    "source_row_sha256": canonical_sha256({"date": trade_date}),
                }
                for index, trade_date in enumerate(dates)
            ],
            key_fields=("exchange", "cal_date"),
        )
        daily = []
        for trade_date in (dates[1], dates[2], dates[4], dates[5]):
            row = {
                "instrumentId": "SZ.000001",
                "sourceCode": "000001.SZ",
                "tradeDate": trade_date,
                "open": "10",
                "high": "11",
                "low": "9",
                "close": "10",
                "previousClose": "10",
                "volumeShares": "1000",
                "amountCny": "10000",
                "adjustment": "RAW",
            }
            row["sourceRowSha256"] = canonical_sha256(row)
            daily.append(row)
        market.write_daily_bars(
            daily,
            source="TUSHARE_COMPATIBLE",
            available_at="2026-01-07T16:30:00+08:00",
        )
        market.seal()
    return root, dates


def _write_candidate(dataset, decision_date, execution_date):
    dataset.write_candidate_partition(
        decision_date=decision_date,
        execution_date=execution_date,
        universe_count=1,
        universe_sha256=hashlib.sha256(b"universe").hexdigest(),
        candidates=[
            {
                "instrumentId": "SZ.000001",
                "board": "MAIN",
                "rankWithinBoard": 1,
                "sampleBucket": "LIQUIDITY_TOP",
                "featureAvailableAt": "2026-01-01T16:30:00+08:00",
                "featureSchemaVersion": "candidate-features.v1",
                "features": {"medianAmount20Cny": "10000"},
                "selectionScore": "10000",
            }
        ],
        rejections=[],
    )


def _write_archive(root, trade_date, *, invalid_close=False):
    minute_root = root / "minutes"
    minute_root.mkdir(parents=True)
    starts = (
        datetime.fromisoformat(f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:]} 09:35:00"),
        datetime.fromisoformat(f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:]} 13:05:00"),
    )
    times = [start + timedelta(minutes=5 * offset) for start in starts for offset in range(24)]
    rows = [
        {
            "date": value.strftime("%Y%m%d%H%M%S"),
            "code": "000001",
            "open": 10,
            "high": 12 if invalid_close and index == 47 else 10,
            "low": 10,
            "close": 12 if invalid_close and index == 47 else 10,
            "volume": 60 if index == 47 else 20,
            "amount": 600 if index == 47 else 200,
            "pre_close": 10,
        }
        for index, value in enumerate(times)
    ]
    path = minute_root / f"{trade_date}.json.gz"
    with gzip.open(path, "wt", encoding="utf-8") as stream:
        json.dump({"date": trade_date, "codes": {"000001": rows}}, stream)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    (root / "backfill-minutes-report.json").write_text(
        json.dumps(
            {
                "repaired": True,
                "datesWritten": 1,
                "written": [{"date": trade_date, "codes": 1, "sha256": digest}],
            }
        )
    )


def _tushare_minute_rows(trade_dates):
    rows = []
    for trade_date in trade_dates:
        starts = (
            datetime.fromisoformat(f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:]} 09:35:00"),
            datetime.fromisoformat(f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:]} 13:05:00"),
        )
        times = [start + timedelta(minutes=5 * offset) for start in starts for offset in range(24)]
        rows.extend(
            {
                "ts_code": "000001.SZ",
                "trade_time": value.strftime("%Y-%m-%d %H:%M:%S"),
                "open": "10",
                "high": "10",
                "low": "10",
                "close": "10",
                "vol": "60" if index == 47 else "20",
                "amount": "600" if index == 47 else "200",
            }
            for index, value in enumerate(times)
        )
    return rows


class _MinuteClient:
    def __init__(self, rows, *, failure=None):
        self.rows_to_return = rows
        self.failure = failure
        self.calls = []

    def rows(self, api_name, params, fields):
        self.calls.append((api_name, params, fields))
        if self.failure:
            raise HistoricalMarketError(self.failure)
        return self.rows_to_return


def test_sse_pre_auction_close_uses_daily_bar_as_terminal_authority():
    rows = [
        {
            "open": "10",
            "high": "10.02",
            "low": "9.99",
            "close": "10",
            "volumeShares": "1000",
            "amountCny": "10000",
        }
    ]
    daily = {
        "open": "10",
        "high": "10.02",
        "low": "9.99",
        "close": "10.01",
        "volume_shares": "1000",
        "amount_cny": "10000",
        "source_row_sha256": "daily-source",
    }

    details = _validate_daily(
        rows,
        daily,
        instrument_id="SH.600000",
        trade_date="20180817",
    )

    assert details["close"] == "10"
    assert details["officialDailyClose"] == "10.01"
    assert details["terminalCloseAuthority"] == "DAILY_BAR"
    assert details["closeReconciliation"] == "SSE_PRE_20180820_OFFICIAL_CLOSE_VWAP"


@pytest.mark.parametrize(
    ("instrument_id", "trade_date"),
    [("SZ.000001", "20180817"), ("SH.600000", "20180820")],
)
def test_close_mismatch_outside_sse_historical_rule_is_rejected(
    instrument_id,
    trade_date,
):
    rows = [
        {
            "open": "10",
            "high": "10.02",
            "low": "9.99",
            "close": "10",
            "volumeShares": "1000",
            "amountCny": "10000",
        }
    ]
    daily = {
        "open": "10",
        "high": "10.02",
        "low": "9.99",
        "close": "10.01",
        "volume_shares": "1000",
        "amount_cny": "10000",
        "source_row_sha256": "daily-source",
    }

    with pytest.raises(MinuteArchiveError, match="MINUTE_DAILY_OPEN_CLOSE_MISMATCH"):
        _validate_daily(
            rows,
            daily,
            instrument_id=instrument_id,
            trade_date=trade_date,
        )


def test_repeated_rejection_updates_audit_details_idempotently(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    with EpisodeDataset(
        tmp_path / "episodes",
        dataset_id="minute-requirement-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as dataset:
        _write_candidate(dataset, dates[0], dates[1])
        with MinuteRequirementBuilder(dataset) as builder:
            builder.build_partition(dates[0])
        kwargs = {
            "instrument_id": "SZ.000001",
            "trade_date": dates[1],
            "source_kind": "TEST_SOURCE",
            "source_asset_sha256": "same-source",
            "reason": "MINUTE_DAILY_VOLUME_MISMATCH",
        }
        with dataset.db:
            reject_minute_requirement(dataset, details={"volumeDeltaShares": "-100"}, **kwargs)
            reject_minute_requirement(dataset, details={"volumeDeltaShares": "-200"}, **kwargs)

        attempts = dataset.db.execute(
            "SELECT details_json FROM minute_ingestion_attempts "
            "WHERE source_kind = 'TEST_SOURCE'"
        ).fetchall()
        assert len(attempts) == 1
        assert json.loads(attempts[0][0])["volumeDeltaShares"] == "-200"


def test_daily_volume_reconciliation_uses_bounded_relative_tolerance():
    daily = {
        "open": "10",
        "high": "10",
        "low": "10",
        "close": "10",
        "volume_shares": "10000000",
        "amount_cny": "100000000",
        "source_row_sha256": "daily-source",
    }
    rows = [
        {
            "open": "10",
            "high": "10",
            "low": "10",
            "close": "10",
            "volumeShares": "9995001",
            "amountCny": "100000000",
        }
    ]

    details = _validate_daily(
        rows,
        daily,
        instrument_id="SZ.000001",
        trade_date="20260102",
    )

    assert details["volumeDeltaShares"] == "-4999"
    assert details["volumeToleranceShares"] == "5000.0000"
    rows[0]["volumeShares"] = "9995000"
    with pytest.raises(MinuteArchiveError, match="MINUTE_DAILY_VOLUME_MISMATCH"):
        _validate_daily(
            rows,
            daily,
            instrument_id="SZ.000001",
            trade_date="20260102",
        )


def test_builder_creates_five_session_requirements_and_marks_missing_daily(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    with EpisodeDataset(
        tmp_path / "episodes",
        dataset_id="minute-requirement-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as dataset:
        _write_candidate(dataset, dates[0], dates[1])
        with MinuteRequirementBuilder(dataset) as builder:
            result = builder.build_partition(dates[0])
            replay = builder.build_partition(dates[0])

        assert result == {
            "decisionDate": dates[0],
            "status": "COMPLETED",
            "episodeCount": 1,
            "requirementLinks": 5,
            "deferredEpisodes": 0,
        }
        assert replay["status"] == "SKIPPED"
        requirements = dataset.db.execute(
            "SELECT trade_date, status, reason FROM minute_requirements ORDER BY trade_date"
        ).fetchall()
        assert [tuple(row) for row in requirements] == [
            (dates[1], "PENDING", None),
            (dates[2], "PENDING", None),
            (dates[3], "NOT_APPLICABLE", "DAILY_BAR_ABSENT"),
            (dates[4], "PENDING", None),
            (dates[5], "PENDING", None),
        ]
        with pytest.raises(
            ValueError,
            match="EPISODE_MINUTE_REQUIREMENTS_INCOMPLETE",
        ):
            dataset.seal()


def test_builder_defers_episode_without_complete_horizon(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    with EpisodeDataset(
        tmp_path / "episodes",
        dataset_id="minute-requirement-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as dataset:
        _write_candidate(dataset, dates[4], dates[5])
        with MinuteRequirementBuilder(dataset) as builder:
            result = builder.build_partition(dates[4])

        assert result["status"] == "DEFERRED"
        assert result["deferredEpisodes"] == 1
        assert dataset.db.execute("SELECT COUNT(*) FROM minute_requirements").fetchone()[0] == 0


def test_archive_import_accepts_only_complete_daily_reconciled_partition(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    archive_root = tmp_path / "archive"
    _write_archive(archive_root, dates[1])
    with EpisodeDataset(
        tmp_path / "episodes",
        dataset_id="minute-requirement-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as dataset:
        _write_candidate(dataset, dates[0], dates[1])
        with MinuteRequirementBuilder(dataset) as builder:
            builder.build_partition(dates[0])
        with MinuteArchiveImporter(dataset, archive_root) as importer:
            result = importer.import_range(dates[1], dates[1])
            replay = importer.import_range(dates[1], dates[1])

        assert result[0]["accepted"] == 1
        assert result[0]["rejected"] == 0
        assert replay[0]["status"] == "SKIPPED"
        assert dataset.db.execute("SELECT COUNT(*) FROM episode_minute_bars").fetchone()[0] == 48
        assert (
            dataset.db.execute(
                "SELECT status FROM minute_requirements WHERE trade_date = ?", (dates[1],)
            ).fetchone()[0]
            == "COMPLETED"
        )


def test_archive_import_records_rejection_without_partial_minute_rows(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    archive_root = tmp_path / "archive"
    _write_archive(archive_root, dates[1], invalid_close=True)
    with EpisodeDataset(
        tmp_path / "episodes",
        dataset_id="minute-requirement-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as dataset:
        _write_candidate(dataset, dates[0], dates[1])
        with MinuteRequirementBuilder(dataset) as builder:
            builder.build_partition(dates[0])
        with MinuteArchiveImporter(dataset, archive_root) as importer:
            result = importer.import_range(dates[1], dates[1])

        assert result[0]["accepted"] == 0
        assert result[0]["rejected"] == 1
        assert dataset.db.execute("SELECT COUNT(*) FROM episode_minute_bars").fetchone()[0] == 0
        requirement = dataset.db.execute(
            "SELECT status, reason, attempt_count FROM minute_requirements WHERE trade_date = ?",
            (dates[1],),
        ).fetchone()
        assert tuple(requirement) == (
            "PENDING",
            "MINUTE_DAILY_OPEN_CLOSE_MISMATCH",
            1,
        )
        rejection_details = json.loads(
            dataset.db.execute(
                "SELECT details_json FROM minute_ingestion_attempts"
            ).fetchone()[0]
        )
        assert rejection_details["close"] == "12"
        assert rejection_details["officialDailyClose"] == "10"
        assert rejection_details["terminalCloseAuthority"] == "DAILY_BAR"


def test_archive_import_accepts_stockdb_final_replay_manifest(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    archive_root = tmp_path / "archive"
    _write_archive(archive_root, dates[1])
    (archive_root / "backfill-minutes-report.json").unlink()
    (archive_root / "archive-replay-manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": "opportunity-archive-replay.v1",
                "dates": [{"date": dates[1], "codes": ["000001"]}],
            }
        )
    )
    with EpisodeDataset(
        tmp_path / "episodes",
        dataset_id="minute-requirement-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as dataset:
        _write_candidate(dataset, dates[0], dates[1])
        with MinuteRequirementBuilder(dataset) as builder:
            builder.build_partition(dates[0])
        with MinuteArchiveImporter(dataset, archive_root) as importer:
            result = importer.import_range(dates[1], dates[1])

        assert result[0]["sourceKind"] == "STOCKDB_ISOLATED_ARCHIVE_V1"
        assert result[0]["accepted"] == 1


def test_archive_import_verifies_tushare_chunk_audit(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    archive_root = tmp_path / "archive"
    _write_archive(archive_root, dates[1])
    (archive_root / "backfill-minutes-report.json").unlink()
    minute_path = archive_root / "minutes" / f"{dates[1]}.json.gz"
    (archive_root / "minute-manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": "stockdb-minute-export-manifest.v1",
                "dates": [{"date": dates[1], "codes": ["000001"]}],
            }
        )
    )
    (archive_root / "tushare-minute-report.json").write_text(
        json.dumps({"schemaVersion": "tushare-minute-export.v1", "frequency": "5min"})
    )
    (archive_root / "audit.json").write_text(
        json.dumps(
            {
                "schemaVersion": "v4-tushare-chunk-audit.v1",
                "files": [
                    {
                        "path": f"minutes/{dates[1]}.json.gz",
                        "sha256": hashlib.sha256(minute_path.read_bytes()).hexdigest(),
                    }
                ],
            }
        )
    )
    with EpisodeDataset(
        tmp_path / "episodes",
        dataset_id="minute-requirement-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as dataset:
        _write_candidate(dataset, dates[0], dates[1])
        with MinuteRequirementBuilder(dataset) as builder:
            builder.build_partition(dates[0])
        with MinuteArchiveImporter(dataset, archive_root) as importer:
            result = importer.import_range(dates[1], dates[1])

        assert result[0]["sourceKind"].startswith("TUSHARE_5MIN_CHUNK_")
        assert result[0]["accepted"] == 1


def test_tushare_archive_hash_mismatch_fails_before_writes(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    archive_root = tmp_path / "archive"
    _write_archive(archive_root, dates[1])
    path = archive_root / "minutes" / f"{dates[1]}.json.gz"
    path.write_bytes(path.read_bytes() + b"tampered")
    with EpisodeDataset(
        tmp_path / "episodes",
        dataset_id="minute-requirement-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as dataset:
        _write_candidate(dataset, dates[0], dates[1])
        with MinuteRequirementBuilder(dataset) as builder:
            builder.build_partition(dates[0])
        with MinuteArchiveImporter(dataset, archive_root) as importer:
            with pytest.raises(MinuteArchiveError, match="MINUTE_ARCHIVE_HASH_MISMATCH"):
                importer.import_range(dates[1], dates[1])

        assert dataset.db.execute("SELECT COUNT(*) FROM episode_minute_bars").fetchone()[0] == 0


def test_fetcher_batches_by_instrument_window_and_accepts_only_required_dates(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    client = _MinuteClient(_tushare_minute_rows([dates[1], dates[2]]))
    with EpisodeDataset(
        tmp_path / "episodes",
        dataset_id="minute-requirement-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as dataset:
        _write_candidate(dataset, dates[0], dates[1])
        with MinuteRequirementBuilder(dataset) as builder:
            builder.build_partition(dates[0])
        with MinuteRequirementFetcher(client, dataset) as fetcher:
            results = list(fetcher.fetch_pending(dates[1], dates[2]))

        assert len(client.calls) == 1
        assert client.calls[0][1] == {
            "ts_code": "000001.SZ",
            "freq": "5min",
            "start_date": "2026-01-02 09:30:00",
            "end_date": "2026-01-03 15:00:00",
        }
        assert results[0]["accepted"] == 2
        assert results[0]["rejected"] == 0
        assert dataset.db.execute("SELECT COUNT(*) FROM episode_minute_bars").fetchone()[0] == 96


def test_fetcher_can_retry_only_selected_rejection_reasons(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    client = _MinuteClient(_tushare_minute_rows([dates[1], dates[2]]))
    with EpisodeDataset(
        tmp_path / "episodes",
        dataset_id="minute-requirement-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as dataset:
        _write_candidate(dataset, dates[0], dates[1])
        with MinuteRequirementBuilder(dataset) as builder:
            builder.build_partition(dates[0])
        dataset.db.execute(
            "UPDATE minute_requirements SET reason = 'RETRY_THIS' WHERE trade_date = ?",
            (dates[1],),
        )
        dataset.db.execute(
            "UPDATE minute_requirements SET reason = 'KEEP_PENDING' WHERE trade_date = ?",
            (dates[2],),
        )
        with MinuteRequirementFetcher(client, dataset) as fetcher:
            results = list(
                fetcher.fetch_pending(
                    dates[1],
                    dates[2],
                    reasons=["RETRY_THIS"],
                )
            )

        assert results[0]["requiredDates"] == [dates[1]]
        assert results[0]["accepted"] == 1
        states = dataset.db.execute(
            "SELECT trade_date, status, reason FROM minute_requirements "
            "WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date",
            (dates[1], dates[2]),
        ).fetchall()
        assert [tuple(row) for row in states] == [
            (dates[1], "COMPLETED", None),
            (dates[2], "PENDING", "KEEP_PENDING"),
        ]


def test_fetcher_records_upstream_failure_and_can_resume(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    client = _MinuteClient([], failure="MARKET_DATA_RATE_LIMITED")
    with EpisodeDataset(
        tmp_path / "episodes",
        dataset_id="minute-requirement-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as dataset:
        _write_candidate(dataset, dates[0], dates[1])
        with MinuteRequirementBuilder(dataset) as builder:
            builder.build_partition(dates[0])
        with MinuteRequirementFetcher(client, dataset) as fetcher:
            with pytest.raises(HistoricalMarketError, match="MARKET_DATA_RATE_LIMITED"):
                list(fetcher.fetch_pending(dates[1], dates[2]))
            failed = dataset.db.execute(
                "SELECT reason, attempt_count FROM minute_requirements "
                "WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date",
                (dates[1], dates[2]),
            ).fetchall()
            assert [tuple(row) for row in failed] == [
                ("MARKET_DATA_RATE_LIMITED", 1),
                ("MARKET_DATA_RATE_LIMITED", 1),
            ]

            client.failure = None
            client.rows_to_return = _tushare_minute_rows([dates[1], dates[2]])
            resumed = list(fetcher.fetch_pending(dates[1], dates[2]))

        assert resumed[0]["accepted"] == 2
        assert (
            dataset.db.execute(
                "SELECT COUNT(*) FROM minute_requirements WHERE status = 'PENDING' "
                "AND trade_date BETWEEN ? AND ?",
                (dates[1], dates[2]),
            ).fetchone()[0]
            == 0
        )


def test_fetcher_isolates_invalid_ohlc_to_its_requirement_date(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    rows = _tushare_minute_rows([dates[1], dates[2]])
    rows[0]["high"] = "9"
    client = _MinuteClient(rows)
    with EpisodeDataset(
        tmp_path / "episodes",
        dataset_id="minute-requirement-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as dataset:
        _write_candidate(dataset, dates[0], dates[1])
        with MinuteRequirementBuilder(dataset) as builder:
            builder.build_partition(dates[0])
        with MinuteRequirementFetcher(client, dataset) as fetcher:
            results = list(fetcher.fetch_pending(dates[1], dates[2]))

        assert results[0]["accepted"] == 1
        assert results[0]["rejected"] == 1
        states = dataset.db.execute(
            "SELECT trade_date, status, reason FROM minute_requirements "
            "WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date",
            (dates[1], dates[2]),
        ).fetchall()
        assert [tuple(row) for row in states] == [
            (dates[1], "PENDING", "INVALID_OHLC"),
            (dates[2], "COMPLETED", None),
        ]
