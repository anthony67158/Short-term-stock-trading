import hashlib
from datetime import datetime, timedelta

from platform_app.modules.experiments.episode_dataset import EpisodeDataset
from platform_app.modules.experiments.label_dataset import LabelDataset
from platform_app.modules.experiments.market_dataset import (
    MarketDataset,
    canonical_sha256,
)
from platform_app.modules.experiments.minute_requirement_builder import (
    MinuteRequirementBuilder,
)
from platform_app.modules.experiments.short_horizon_policy import SHORT_HORIZON_POLICY


def _sealed_upstreams(tmp_path):
    market_root = tmp_path / "market"
    dates = [f"2026010{day}" for day in range(1, 7)]
    with MarketDataset(
        market_root,
        dataset_id="label-market",
        source="SYNTHETIC",
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
            "source": "SYNTHETIC",
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
                    "source": "SYNTHETIC",
                    "available_at": f"{trade_date}T16:30:00+08:00",
                    "source_row_sha256": canonical_sha256({"date": trade_date}),
                }
                for index, trade_date in enumerate(dates)
            ],
            key_fields=("exchange", "cal_date"),
        )
        daily = []
        for trade_date in dates:
            row = {
                "instrumentId": "SZ.000001",
                "sourceCode": "000001.SZ",
                "tradeDate": trade_date,
                "open": "10",
                "high": "10",
                "low": "10",
                "close": "10",
                "previousClose": "10",
                "volumeShares": "4800000",
                "amountCny": "48000000",
                "adjustment": "RAW",
            }
            row["sourceRowSha256"] = canonical_sha256(row)
            daily.append(row)
        market.write_daily_bars(
            daily,
            source="SYNTHETIC",
            available_at="2026-01-06T16:30:00+08:00",
        )
        market.seal()

    episode_root = tmp_path / "episodes"
    with EpisodeDataset(
        episode_root,
        dataset_id="label-episodes",
        market_dataset_root=market_root,
        policy=SHORT_HORIZON_POLICY,
    ) as episodes:
        episodes.write_candidate_partition(
            decision_date=dates[0],
            execution_date=dates[1],
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
                    "features": {"medianAmount20Cny": "48000000"},
                    "selectionScore": "48000000",
                }
            ],
            rejections=[],
        )
        with MinuteRequirementBuilder(episodes) as builder:
            builder.build_partition(dates[0])
        for trade_date in dates[1:]:
            starts = (
                datetime.fromisoformat(
                    f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:]} 09:35:00"
                ),
                datetime.fromisoformat(
                    f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:]} 13:05:00"
                ),
            )
            for start in starts:
                for offset in range(24):
                    bar_end = start + timedelta(minutes=5 * offset)
                    episodes.db.execute(
                        "INSERT INTO episode_minute_bars VALUES "
                        "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            "SZ.000001",
                            trade_date,
                            bar_end.strftime("%Y-%m-%d %H:%M:%S"),
                            "10",
                            "10",
                            "10",
                            "10",
                            "100000",
                            "1000000",
                            "SYNTHETIC",
                            "asset",
                            hashlib.sha256(str(bar_end).encode()).hexdigest(),
                        ),
                    )
            episodes.db.execute(
                "UPDATE minute_requirements SET status = 'COMPLETED', "
                "completed_at = '2026-01-07T00:00:00+00:00' "
                "WHERE instrument_id = 'SZ.000001' AND trade_date = ?",
                (trade_date,),
            )
        episodes.db.commit()
        episodes.seal()
    return market_root, episode_root, dates


def test_label_dataset_builds_replays_and_seals_bound_labels(tmp_path):
    market_root, episode_root, dates = _sealed_upstreams(tmp_path)
    root = tmp_path / "labels"
    with LabelDataset(
        root,
        dataset_id="short-horizon-labels-v1",
        episode_dataset_root=episode_root,
        market_dataset_root=market_root,
    ) as labels:
        result = labels.build_partition(dates[0])
        replay = labels.build_partition(dates[0])
        reference = labels.db.execute(
            "SELECT * FROM episode_labels WHERE reference_100k = 1"
        ).fetchone()
        one_lot = labels.db.execute(
            "SELECT * FROM episode_labels WHERE target_shares = 100"
        ).fetchone()
        manifest = labels.seal()

    assert result["eligibleCount"] == 1
    assert result["unavailableCount"] == 0
    assert result["scenarioCount"] == 5
    assert replay["status"] == "SKIPPED"
    assert reference["p_fill_label"] == 1
    assert reference["filled_shares"] == 10000
    assert reference["exit_reason"] == "TERMINAL"
    assert one_lot["p_full_fill_label"] == 1
    assert manifest["schemaVersion"] == "label-dataset.v2"
    assert manifest["labels"]["episodes"] == 1
    assert manifest["labels"]["scenarios"] == 5
    assert manifest["labelsByBoard"] == {"MAIN": 1}
