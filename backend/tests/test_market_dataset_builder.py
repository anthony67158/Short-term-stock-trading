import sqlite3

import pytest

from platform_app.modules.experiments.market_dataset import MarketDataset, MarketDatasetError
from platform_app.modules.experiments.market_dataset_builder import MarketDatasetBuilder


class FakeClient:
    def __init__(self, responses):
        self.responses = responses

    def rows(self, api_name, params, fields):
        key = (api_name, params.get("list_status") or params.get("trade_date") or "")
        return self.responses.get(key, self.responses.get((api_name, ""), []))


def stock(code, name, market, exchange, list_date="20100101"):
    return {
        "ts_code": code,
        "symbol": code[:6],
        "name": name,
        "market": market,
        "exchange": exchange,
        "list_status": "L",
        "list_date": list_date,
        "delist_date": None,
    }


def bar(code):
    return {
        "ts_code": code,
        "trade_date": "20260915",
        "open": "10",
        "high": "11",
        "low": "9",
        "close": "10",
        "pre_close": "10",
        "vol": "1",
        "amount": "1",
    }


def responses():
    listed = [
        stock("000001.SZ", "Main", "主板", "SZSE"),
        stock("300001.SZ", "ChiNext", "创业板", "SZSE"),
        stock("688001.SH", "STAR", "科创板", "SSE"),
        stock("920729.BJ", "Beijing", "北交所", "BSE", "20200727"),
    ]
    codes = [row["ts_code"] for row in listed[:3]]
    return {
        ("bse_mapping", ""): [{
            "name": "Beijing", "o_code": "839729.BJ",
            "n_code": "920729.BJ", "list_date": "20200727",
        }],
        ("stock_basic", "L"): listed,
        ("stock_basic", "D"): [],
        ("stock_basic", "P"): [],
        ("trade_cal", ""): [{
            "exchange": "SSE", "cal_date": "20260915",
            "is_open": "1", "pretrade_date": "20260914",
        }],
        ("daily", "20260915"): [bar(code) for code in codes],
        ("adj_factor", "20260915"): [
            {"ts_code": code, "trade_date": "20260915", "adj_factor": "1"}
            for code in codes
        ],
        ("suspend_d", "20260915"): [{
            "ts_code": "920729.BJ", "trade_date": "20260915",
            "suspend_type": "S", "suspend_timing": None,
        }],
    }


def test_builder_syncs_reference_and_complete_daily_partition(tmp_path):
    root = tmp_path / "dataset"
    with MarketDataset(root, dataset_id="all-a-share", source="TUSHARE_COMPATIBLE") as ds:
        builder = MarketDatasetBuilder(
            FakeClient(responses()),
            ds,
            observed_at=lambda: "2026-09-16T01:00:00+00:00",
        )
        assert builder.sync_reference("20160101", "20260915") == {
            "status": "COMPLETED",
            "instruments": 4,
            "aliases": 1,
            "calendarDays": 1,
        }
        result = builder.sync_daily_partition("20260915")
        assert result["dailyBars"] == 3
        assert result["suspensions"] == 1
        assert builder.sync_daily_partition("20260915")["status"] == "SKIPPED"

    with sqlite3.connect(root / "market.sqlite3") as db:
        checkpoint = db.execute(
            "SELECT first_seen_at, available_at, availability_method "
            "FROM sync_checkpoints WHERE stream = 'daily'"
        ).fetchone()
        assert checkpoint == (
            "2026-09-16T01:00:00+00:00",
            "2026-09-15T16:30:00+08:00",
            "RECONSTRUCTED_FROM_VENDOR_SCHEDULE",
        )
        bse_dates = db.execute(
            "SELECT list_date, source_list_date FROM instruments "
            "WHERE instrument_id = 'BJ.920729'"
        ).fetchone()
        assert bse_dates == ("20211115", "20200727")


def test_builder_rejects_unexplained_missing_daily_before_writing(tmp_path):
    data = responses()
    data[("suspend_d", "20260915")] = []
    root = tmp_path / "dataset"
    with MarketDataset(root, dataset_id="all-a-share", source="TUSHARE_COMPATIBLE") as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")
        with pytest.raises(MarketDatasetError, match="DAILY_COVERAGE_INCOMPLETE:1"):
            builder.sync_daily_partition("20260915")
        assert ds.db.execute("SELECT COUNT(*) FROM daily_bars").fetchone()[0] == 0


def test_builder_rejects_vendor_row_limit_as_possible_truncation(tmp_path):
    data = responses()
    data[("daily", "20260915")] = [bar("000001.SZ")] * 6000
    with MarketDataset(
        tmp_path / "dataset", dataset_id="all-a-share", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")
        with pytest.raises(MarketDatasetError, match="DAILY_MAY_BE_TRUNCATED"):
            builder.sync_daily_partition("20260915")


def test_reference_ignores_nonstandard_security_that_cannot_overlap_range(tmp_path):
    data = responses()
    data[("stock_basic", "D")] = [{
        "ts_code": "T600018.SH",
        "symbol": "T600018",
        "name": "Historical Transfer Security",
        "market": None,
        "exchange": "SSE",
        "list_status": "D",
        "list_date": "20000719",
        "delist_date": "20061020",
    }]
    with MarketDataset(
        tmp_path / "dataset", dataset_id="all-a-share", source="TUSHARE_COMPATIBLE"
    ) as ds:
        result = MarketDatasetBuilder(FakeClient(data), ds).sync_reference(
            "20160101", "20260915"
        )
        assert result["instruments"] == 4
