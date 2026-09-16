from datetime import date, timedelta

from platform_app.modules.experiments.candidate_episode_builder import (
    CandidateEpisodeBuilder,
)
from platform_app.modules.experiments.episode_dataset import EpisodeDataset
from platform_app.modules.experiments.market_dataset import (
    MarketDataset,
    canonical_sha256,
)
from platform_app.modules.experiments.short_horizon_policy import (
    SHORT_HORIZON_POLICY,
)


def _instrument(instrument_id, source_code, board):
    row = {
        "instrumentId": instrument_id,
        "sourceCode": source_code,
        "exchange": instrument_id[:2],
        "board": board,
        "name": f"Synthetic {instrument_id}",
        "listStatus": "L",
        "listDate": "20200101",
        "delistDate": None,
        "source": "TUSHARE_COMPATIBLE",
        "availableAt": "2020-01-01T16:30:00+08:00",
    }
    row["sourceRowSha256"] = canonical_sha256(row)
    return row


def _seed_market_dataset(tmp_path):
    root = tmp_path / "market"
    securities = [
        ("SH.600001", "600001.SH", "MAIN", 10, 100_000_000),
        ("SZ.000001", "000001.SZ", "MAIN", 10, 10_000_000),
        ("SZ.000002", "000002.SZ", "MAIN", 10, 90_000_000),
        ("SZ.000003", "000003.SZ", "MAIN", 10, 80_000_000),
        ("SZ.300001", "300001.SZ", "CHINEXT", 20, 70_000_000),
        ("SH.688001", "688001.SH", "STAR", 30, 60_000_000),
        ("BJ.920001", "920001.BJ", "BEIJING", 40, 50_000_000),
        ("SH.600999", "600999.SH", "MAIN", 10, 0),
    ]
    dates = [
        (date(2026, 1, 1) + timedelta(days=offset)).strftime("%Y%m%d")
        for offset in range(64)
    ]
    with MarketDataset(
        root,
        dataset_id="synthetic-market",
        source="TUSHARE_COMPATIBLE",
    ) as market:
        market.write_instruments(
            [_instrument(item[0], item[1], item[2]) for item in securities]
        )
        calendar = [
            {
                "exchange": "SSE",
                "cal_date": trade_date,
                "is_open": 1,
                "previous_open_date": dates[index - 1] if index else None,
                "source": "TUSHARE_COMPATIBLE",
                "available_at": f"{trade_date}T00:00:00+08:00",
                "source_row_sha256": canonical_sha256({"calendar": trade_date}),
            }
            for index, trade_date in enumerate(dates)
        ]
        market.write_facts(
            "trade_calendar",
            calendar,
            key_fields=("exchange", "cal_date"),
        )
        daily_rows = []
        factors = []
        for instrument_id, source_code, _board, base, amount in securities[:-1]:
            instrument_dates = dates[:63]
            if instrument_id == "SZ.000002":
                instrument_dates = dates[53:63]
            if instrument_id == "SH.600999":
                instrument_dates = []
            previous_close = str(base)
            for index, trade_date in enumerate(instrument_dates):
                close = str(base + index / 100)
                row = {
                    "instrumentId": instrument_id,
                    "sourceCode": source_code,
                    "tradeDate": trade_date,
                    "open": previous_close,
                    "high": close,
                    "low": previous_close,
                    "close": close,
                    "previousClose": previous_close,
                    "volumeShares": "1000000",
                    "amountCny": str(amount),
                    "adjustment": "RAW",
                }
                row["sourceRowSha256"] = canonical_sha256(row)
                daily_rows.append(row)
                factors.append(
                    {
                        "instrument_id": instrument_id,
                        "source_code": source_code,
                        "trade_date": trade_date,
                        "factor": "1",
                        "source": "TUSHARE_COMPATIBLE",
                        "available_at": f"{trade_date}T09:20:00+08:00",
                        "source_row_sha256": canonical_sha256(
                            {"factor": instrument_id, "date": trade_date}
                        ),
                    }
                )
                previous_close = close
        market.write_daily_bars(
            daily_rows,
            source="TUSHARE_COMPATIBLE",
            available_at=f"{dates[62]}T16:30:00+08:00",
        )
        market.write_facts(
            "adjustment_factors",
            factors,
            key_fields=("instrument_id", "trade_date"),
        )
        market.write_facts(
            "suspensions",
            [
                {
                    "instrument_id": "SZ.000003",
                    "source_code": "000003.SZ",
                    "trade_date": dates[62],
                    "suspend_type": "S",
                    "suspend_timing": "DAY",
                    "source": "TUSHARE_COMPATIBLE",
                    "available_at": f"{dates[62]}T09:00:00+08:00",
                    "source_row_sha256": canonical_sha256({"suspended": "SZ.000003"}),
                }
            ],
            key_fields=(
                "instrument_id",
                "trade_date",
                "suspend_type",
                "suspend_timing",
            ),
        )
        market.seal()
    return root, dates


def test_builder_accounts_for_full_universe_and_selects_each_board(tmp_path):
    market_root, dates = _seed_market_dataset(tmp_path)
    episode_root = tmp_path / "episodes"
    policy = {
        **SHORT_HORIZON_POLICY,
        "candidatePolicy": {
            **SHORT_HORIZON_POLICY["candidatePolicy"],
            "quotaPerBoard": 1,
        },
    }
    with EpisodeDataset(
        episode_root,
        dataset_id="synthetic-episodes",
        market_dataset_root=market_root,
        policy=policy,
    ) as episodes:
        with CandidateEpisodeBuilder(episodes, policy) as builder:
            result = builder.build_partition(dates[62], dates[63])

        assert result == {
            "decisionDate": dates[62],
            "executionDate": dates[63],
            "status": "COMPLETED",
            "universeCount": 8,
            "candidateCount": 4,
            "rejectionCount": 4,
            "boards": {"BEIJING": 1, "CHINEXT": 1, "MAIN": 1, "STAR": 1},
        }
        selected = episodes.db.execute(
            "SELECT instrument_id, board, features_json "
            "FROM candidate_episodes ORDER BY board"
        ).fetchall()
        assert [row["instrument_id"] for row in selected] == [
            "BJ.920001",
            "SZ.300001",
            "SH.600001",
            "SH.688001",
        ]
        reasons = {
            (row["reason"], row["instrument_count"])
            for row in episodes.db.execute(
                "SELECT reason, instrument_count "
                "FROM candidate_partition_rejections"
            )
        }
        assert reasons == {
            ("INSUFFICIENT_HISTORY", 1),
            ("NO_DECISION_DATE_BAR", 1),
            ("NOT_SELECTED_BY_BOARD_QUOTA", 1),
            ("SUSPENDED", 1),
        }


def test_builder_defers_last_market_date_and_resumes_completed_dates(tmp_path):
    market_root, dates = _seed_market_dataset(tmp_path)
    episode_root = tmp_path / "episodes"
    with EpisodeDataset(
        episode_root,
        dataset_id="synthetic-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as episodes:
        with CandidateEpisodeBuilder(episodes, SHORT_HORIZON_POLICY) as builder:
            first = builder.build_range(dates[62], dates[63])
            second = builder.build_range(dates[62], dates[63])

    assert [row["status"] for row in first] == ["COMPLETED", "DEFERRED"]
    assert [row["status"] for row in second] == ["SKIPPED", "DEFERRED"]

    reference_root = tmp_path / "reference-episodes"
    with EpisodeDataset(
        reference_root,
        dataset_id="synthetic-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as episodes:
        with CandidateEpisodeBuilder(episodes, SHORT_HORIZON_POLICY) as builder:
            builder.build_partition(dates[62], dates[63])
        reference_hash = episodes.db.execute(
            "SELECT payload_sha256 FROM candidate_partitions"
        ).fetchone()[0]
    with EpisodeDataset(
        episode_root,
        dataset_id="synthetic-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as episodes:
        streaming_hash = episodes.db.execute(
            "SELECT payload_sha256 FROM candidate_partitions"
        ).fetchone()[0]
    assert streaming_hash == reference_hash
