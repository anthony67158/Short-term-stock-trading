import hashlib

from platform_app.modules.experiments.episode_dataset import EpisodeDataset
from platform_app.modules.experiments.market_dataset import (
    MarketDataset,
    canonical_sha256,
)
from platform_app.modules.experiments.minute_requirement_builder import (
    MinuteRequirementBuilder,
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
