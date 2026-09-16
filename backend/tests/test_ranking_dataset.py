from datetime import date, timedelta

from platform_app.modules.experiments.market_dataset import (
    MarketDataset,
    canonical_sha256,
)
from platform_app.modules.experiments.ranking_dataset import RankingDataset


def _sealed_market(tmp_path):
    root = tmp_path / "market"
    dates = [
        (date(2025, 1, 1) + timedelta(days=offset)).strftime("%Y%m%d")
        for offset in range(70)
    ]
    instruments = [
        {
            "instrumentId": "SZ.000001",
            "sourceCode": "000001.SZ",
            "exchange": "SZ",
            "board": "MAIN",
            "name": "Main",
            "listStatus": "L",
            "listDate": dates[0],
            "delistDate": None,
            "source": "SYNTHETIC",
            "availableAt": "2025-01-01T16:30:00+08:00",
        },
        {
            "instrumentId": "BJ.920001",
            "sourceCode": "920001.BJ",
            "exchange": "BJ",
            "board": "BEIJING",
            "name": "Beijing",
            "listStatus": "L",
            "listDate": dates[0],
            "delistDate": None,
            "source": "SYNTHETIC",
            "availableAt": "2025-01-01T16:30:00+08:00",
        },
    ]
    for instrument in instruments:
        instrument["sourceRowSha256"] = canonical_sha256(instrument)
    with MarketDataset(
        root,
        dataset_id="ranking-market",
        source="SYNTHETIC",
    ) as market:
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
                    "available_at": f"{trade_date}T16:30:00+08:00",
                    "source_row_sha256": canonical_sha256({"date": trade_date}),
                }
                for index, trade_date in enumerate(dates)
            ],
            key_fields=("exchange", "cal_date"),
        )
        daily = []
        factors = []
        for instrument in instruments:
            for index, trade_date in enumerate(dates):
                price = 10 + index / 100
                row = {
                    "instrumentId": instrument["instrumentId"],
                    "sourceCode": instrument["sourceCode"],
                    "tradeDate": trade_date,
                    "open": str(price),
                    "high": str(price + 0.05),
                    "low": str(price - 0.05),
                    "close": str(price),
                    "previousClose": str(price - 0.01),
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
                    "factor": "1",
                    "source": "SYNTHETIC",
                    "available_at": "2025-03-11T16:30:00+08:00",
                }
                factor["source_row_sha256"] = canonical_sha256(factor)
                factors.append(factor)
        market.write_daily_bars(
            daily,
            source="SYNTHETIC",
            available_at="2025-03-11T16:30:00+08:00",
        )
        market.write_facts(
            "adjustment_factors",
            factors,
            key_fields=("instrument_id", "trade_date"),
        )
        market.seal()
    return root, dates


def test_ranking_dataset_resumes_by_instrument_and_covers_all_boards(tmp_path):
    market_root, dates = _sealed_market(tmp_path)
    root = tmp_path / "ranking"
    kwargs = {
        "dataset_id": "ranking-v1",
        "market_dataset_root": market_root,
        "start_date": dates[0],
        "end_date": dates[-1],
    }
    with RankingDataset(root, **kwargs) as dataset:
        first = list(dataset.build(max_instruments=1))
        assert first[0]["samples"] == 5

    with RankingDataset(root, **kwargs) as dataset:
        second = list(dataset.build())
        manifest = dataset.seal()

    assert len(second) == 1
    assert second[0]["samples"] == 5
    assert manifest["instruments"] == 2
    assert manifest["universeStockDates"] == 140
    assert manifest["samples"] == 10
    assert manifest["samplesByBoard"] == {"BEIJING": 5, "MAIN": 5}
    assert manifest["unavailableByReason"] == {
        "HORIZON_INCOMPLETE": 10,
        "INSUFFICIENT_DATASET_HISTORY": 120,
    }
