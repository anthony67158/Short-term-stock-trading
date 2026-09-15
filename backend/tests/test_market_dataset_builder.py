import json
import sqlite3
from datetime import datetime, timedelta

import pytest

from platform_app.modules.experiments.market_dataset import MarketDataset, MarketDatasetError
from platform_app.modules.experiments.market_dataset_builder import MarketDatasetBuilder


class FakeClient:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def rows(self, api_name, params, fields):
        self.calls.append((api_name, params, fields))
        key = (api_name, params.get("list_status") or params.get("trade_date") or "")
        rows = self.responses.get(key, self.responses.get((api_name, ""), []))
        if api_name == "namechange":
            offset = params.get("offset", 0)
            limit = params.get("limit", len(rows))
            return rows[offset : offset + limit]
        return rows


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


def bar(code, trade_date="20260915"):
    return {
        "ts_code": code,
        "trade_date": trade_date,
        "open": "10",
        "high": "11",
        "low": "9",
        "close": "10",
        "pre_close": "10",
        "vol": "1",
        "amount": "1",
    }


def minute_rows(code, trade_date="20260915"):
    date = datetime.strptime(trade_date, "%Y%m%d").strftime("%Y-%m-%d")
    starts = (
        datetime.fromisoformat(f"{date} 09:35:00"),
        datetime.fromisoformat(f"{date} 13:05:00"),
    )
    times = [start + timedelta(minutes=5 * offset) for start in starts for offset in range(24)]
    return list(
        reversed(
            [
                {
                    "ts_code": code,
                    "trade_time": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "open": "10",
                    "high": "11",
                    "low": "9",
                    "close": "10",
                    "vol": "100" if index == 0 else "0",
                    "amount": "1000" if index == 0 else "0",
                }
                for index, time in enumerate(times)
            ]
        )
    )


def responses():
    listed = [
        stock("000001.SZ", "Main", "主板", "SZSE"),
        stock("300001.SZ", "ChiNext", "创业板", "SZSE"),
        stock("688001.SH", "STAR", "科创板", "SSE"),
        stock("920729.BJ", "Beijing", "北交所", "BSE", "20200727"),
    ]
    codes = [row["ts_code"] for row in listed[:3]]
    return {
        ("bse_mapping", ""): [
            {
                "name": "Beijing",
                "o_code": "839729.BJ",
                "n_code": "920729.BJ",
                "list_date": "20200727",
            }
        ],
        ("stock_basic", "L"): listed,
        ("stock_basic", "D"): [],
        ("stock_basic", "P"): [],
        ("trade_cal", ""): [
            {
                "exchange": "SSE",
                "cal_date": "20260915",
                "is_open": "1",
                "pretrade_date": "20260914",
            }
        ],
        ("daily", "20260915"): [bar(code) for code in codes],
        ("adj_factor", "20260915"): [
            {"ts_code": code, "trade_date": "20260915", "adj_factor": "1"} for code in codes
        ],
        ("suspend_d", "20260915"): [
            {
                "ts_code": "920729.BJ",
                "trade_date": "20260915",
                "suspend_type": "S",
                "suspend_timing": None,
            }
        ],
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
            "listingStatusPeriods": 0,
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
            "SELECT list_date, source_list_date FROM instruments WHERE instrument_id = 'BJ.920729'"
        ).fetchone()
        assert bse_dates == ("20211115", "20200727")


def test_builder_syncs_paginated_name_changes_with_historical_availability(tmp_path):
    data = responses()
    current = {
        "ts_code": "000001.SZ",
        "name": "Current Name",
        "start_date": "20160108",
        "end_date": None,
        "ann_date": "20160107",
        "change_reason": "改名",
    }
    data[("namechange", "")] = [
        current,
        current.copy(),
        {
            **current,
            "name": "Expired Name",
            "start_date": "20100101",
            "end_date": "20151231",
            "ann_date": "20091231",
        },
        {
            **current,
            "name": "Future Name",
            "start_date": "20260916",
            "ann_date": "20260915",
        },
    ]

    with MarketDataset(
        tmp_path / "dataset", dataset_id="name-history", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")

        assert builder.sync_name_changes("20160101", "20260915") == {
            "status": "COMPLETED",
            "nameChanges": 1,
            "discardedExactDuplicates": 1,
            "discardedAliasDuplicates": 0,
        }
        assert builder.sync_name_changes("20160101", "20260915") == {"status": "SKIPPED"}
        row = ds.db.execute(
            "SELECT name, available_at FROM name_changes WHERE instrument_id = 'SZ.000001'"
        ).fetchone()
        assert tuple(row) == ("Current Name", "2016-01-08T16:30:00+08:00")


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


def test_builder_syncs_complete_minute_partition_and_audits_daily_aggregation(tmp_path):
    data = responses()
    data[("stk_mins", "")] = minute_rows("000001.SZ")
    with MarketDataset(
        tmp_path / "dataset", dataset_id="minute-history", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(
            FakeClient(data),
            ds,
            observed_at=lambda: "2026-09-16T01:00:00+00:00",
        )
        builder.sync_reference("20160101", "20260915")
        builder.sync_daily_partition("20260915")

        result = builder.sync_minute_partition("SZ.000001", "20260915")

        assert result == {
            "status": "COMPLETED",
            "instrumentId": "SZ.000001",
            "tradeDate": "20260915",
            "minuteBars": 48,
            "volumeDeltaShares": "0",
            "amountDeltaCny": "0",
        }
        assert builder.sync_minute_partition("SZ.000001", "20260915")["status"] == "SKIPPED"
        first, last, count = ds.db.execute(
            "SELECT min(bar_end_shanghai), max(bar_end_shanghai), count(*) "
            "FROM minute_bars WHERE instrument_id = 'SZ.000001'"
        ).fetchone()
        assert (first, last, count) == (
            "2026-09-15 09:35:00",
            "2026-09-15 15:00:00",
            48,
        )
        details = json.loads(
            ds.db.execute(
                "SELECT details_json FROM sync_checkpoints "
                "WHERE stream = 'minute_5min' AND partition_key = 'SZ.000001:20260915'"
            ).fetchone()[0]
        )
        assert details["aggregation"]["amountToleranceCny"] == "2"


def test_builder_rejects_incomplete_minute_session_before_writing(tmp_path):
    data = responses()
    data[("stk_mins", "")] = minute_rows("300001.SZ")[:-1]
    with MarketDataset(
        tmp_path / "dataset", dataset_id="minute-incomplete", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")
        builder.sync_daily_partition("20260915")

        with pytest.raises(MarketDatasetError, match="MINUTE_SESSION_INCOMPLETE"):
            builder.sync_minute_partition("SZ.300001", "20260915")

        assert ds.db.execute("SELECT COUNT(*) FROM minute_bars").fetchone()[0] == 0


def test_builder_requests_bse_minutes_with_current_stable_source_code(tmp_path):
    data = responses()
    trade_date = "20211115"
    data[("trade_cal", "")] = [
        {
            "exchange": "SSE",
            "cal_date": trade_date,
            "is_open": "1",
            "pretrade_date": "20211112",
        }
    ]
    traded_codes = ["000001.SZ", "300001.SZ", "688001.SH", "839729.BJ"]
    data[("daily", trade_date)] = [bar(code, trade_date) for code in traded_codes]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"} for code in traded_codes
    ]
    data[("suspend_d", trade_date)] = []
    data[("stk_mins", "")] = minute_rows("920729.BJ", trade_date)
    client = FakeClient(data)

    with MarketDataset(
        tmp_path / "dataset", dataset_id="bse-minute-code", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(client, ds)
        builder.sync_reference("20211115", "20211115")
        builder.sync_daily_partition(trade_date)

        result = builder.sync_minute_partition("BJ.920729", trade_date)

        assert result["minuteBars"] == 48
        minute_call = next(call for call in client.calls if call[0] == "stk_mins")
        assert minute_call[1]["ts_code"] == "920729.BJ"
        assert (
            ds.db.execute(
                "SELECT DISTINCT source_code FROM minute_bars WHERE instrument_id = 'BJ.920729'"
            ).fetchone()[0]
            == "920729.BJ"
        )
        assert (
            ds.db.execute(
                "SELECT source_code FROM daily_bars "
                "WHERE instrument_id = 'BJ.920729' AND trade_date = ?",
                (trade_date,),
            ).fetchone()[0]
            == "839729.BJ"
        )


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
    data[("stock_basic", "D")] = [
        {
            "ts_code": "T600018.SH",
            "symbol": "T600018",
            "name": "Historical Transfer Security",
            "market": None,
            "exchange": "SSE",
            "list_status": "D",
            "list_date": "20000719",
            "delist_date": "20061020",
        }
    ]
    with MarketDataset(
        tmp_path / "dataset", dataset_id="all-a-share", source="TUSHARE_COMPATIBLE"
    ) as ds:
        result = MarketDatasetBuilder(FakeClient(data), ds).sync_reference("20160101", "20260915")
        assert result["instruments"] == 4


def test_historical_listing_status_and_pre_bse_rows_explain_coverage(tmp_path):
    data = responses()
    data[("stock_basic", "L")].extend(
        [
            stock("001872.SZ", "Renamed Port", "主板", "SZSE", "19930505"),
            stock("001914.SZ", "Renamed Property", "主板", "SZSE", "19940928"),
            stock("302132.SZ", "Renamed Aviation", "创业板", "SZSE", "20100827"),
        ]
    )
    data[("stock_basic", "D")] = [
        {
            **stock("600656.SH", "Delisted Shanghai", "主板", "SSE"),
            "list_status": "D",
            "delist_date": "20160513",
        },
        {
            **stock("000033.SZ", "Delisted Shenzhen", "主板", "SZSE"),
            "list_status": "D",
            "delist_date": "20170707",
        },
    ]
    trade_date = "20160104"
    traded_codes = [
        "000001.SZ",
        "300001.SZ",
        "688001.SH",
        "000022.SZ",
        "000043.SZ",
        "300114.SZ",
        "001872.SZ",
        "001914.SZ",
        "302132.SZ",
    ]
    data[("daily", trade_date)] = [
        *(bar(code, trade_date) for code in traded_codes),
        bar("839729.BJ", trade_date),
    ]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"}
        for code in [*traded_codes, "839729.BJ"]
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / "dataset", dataset_id="historical-status", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        reference = builder.sync_reference("20160101", "20260915")
        assert reference["listingStatusPeriods"] == 2
        assert reference["aliases"] == 4
        assert builder.aliases()["000022.SZ"] == "001872.SZ"
        result = builder.sync_daily_partition(trade_date)
        assert result["dailyBars"] == 6
        assert result["discardedPreListingBseRows"] == 2
        assert result["discardedAliasDuplicates"] == 6
        details = json.loads(
            ds.db.execute(
                "SELECT details_json FROM sync_checkpoints "
                "WHERE stream = 'daily' AND partition_key = ?",
                (trade_date,),
            ).fetchone()[0]
        )
        assert details["discardedPreListingBseRows"]["daily"]["count"] == 1
        assert details["discardedPreListingBseRows"]["adjustmentFactors"]["count"] == 1
        assert details["listingStatusExplanations"] == ["SH.600656", "SZ.000033"]


def test_daily_sync_repairs_new_official_listing_status_facts(tmp_path):
    data = responses()
    data[("stock_basic", "L")].append(
        stock("600732.SH", "Suspended Shanghai", "主板", "SSE", "19960816")
    )
    trade_date = "20160408"
    traded_codes = ["000001.SZ", "300001.SZ", "688001.SH"]
    data[("daily", trade_date)] = [bar(code, trade_date) for code in traded_codes]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"}
        for code in [*traded_codes, "600732.SH"]
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / "dataset", dataset_id="resumed-official-facts", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")
        ds.db.execute("DELETE FROM listing_status_periods WHERE instrument_id = 'SH.600732'")
        ds.db.commit()

        result = builder.sync_daily_partition(trade_date)

        assert result["dailyBars"] == 3
        assert ds.listing_status_explanations(trade_date) == {"SH.600732": ["SUSPENDED_LISTING"]}
        assert (
            ds.db.execute(
                "SELECT COUNT(*) FROM sync_checkpoints WHERE stream = 'official_market_facts'"
            ).fetchone()[0]
            == 1
        )


def test_historical_xintai_listing_suspension_explains_missing_daily(tmp_path):
    data = responses()
    data[("stock_basic", "D")] = [
        {
            **stock("300372.SZ", "Xintai", "创业板", "SZSE", "20140127"),
            "list_status": "D",
            "delist_date": "20170828",
        }
    ]
    trade_date = "20160906"
    traded_codes = ["000001.SZ", "300001.SZ", "688001.SH"]
    data[("daily", trade_date)] = [bar(code, trade_date) for code in traded_codes]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"}
        for code in [*traded_codes, "300372.SZ"]
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / "dataset", dataset_id="xintai-suspension", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")

        result = builder.sync_daily_partition(trade_date)

        assert result["dailyBars"] == 3
        assert ds.listing_status_explanations(trade_date) == {
            "SZ.300372": ["SUSPENDED_LISTING"]
        }


def test_historical_pangang_listing_suspension_explains_missing_daily(tmp_path):
    data = responses()
    data[("stock_basic", "L")].append(
        stock("000629.SZ", "Pangang Vanadium", "主板", "SZSE", "19961115")
    )
    trade_date = "20170505"
    traded_codes = ["000001.SZ", "300001.SZ", "688001.SH"]
    data[("daily", trade_date)] = [bar(code, trade_date) for code in traded_codes]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"}
        for code in [*traded_codes, "000629.SZ"]
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / "dataset", dataset_id="pangang-suspension", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")

        result = builder.sync_daily_partition(trade_date)

        assert result["dailyBars"] == 3
        assert ds.listing_status_explanations(trade_date) == {
            "SZ.000629": ["SUSPENDED_LISTING"]
        }


def test_historical_jianfeng_listing_suspension_explains_missing_daily(tmp_path):
    data = responses()
    data[("stock_basic", "L")].append(
        stock("000950.SZ", "Jianfeng", "主板", "SZSE", "19990916")
    )
    trade_date = "20170511"
    traded_codes = ["000001.SZ", "300001.SZ", "688001.SH"]
    data[("daily", trade_date)] = [bar(code, trade_date) for code in traded_codes]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"}
        for code in [*traded_codes, "000950.SZ"]
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / "dataset", dataset_id="jianfeng-suspension", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")

        result = builder.sync_daily_partition(trade_date)

        assert result["dailyBars"] == 3
        assert ds.listing_status_explanations(trade_date) == {
            "SZ.000950": ["SUSPENDED_LISTING"]
        }


def test_historical_kunming_machine_listing_suspension_explains_missing_daily(tmp_path):
    data = responses()
    data[("stock_basic", "D")] = [
        {
            **stock("600806.SH", "Kunming Machine", "主板", "SSE", "19940103"),
            "list_status": "D",
            "delist_date": "20180713",
        }
    ]
    trade_date = "20170523"
    traded_codes = ["000001.SZ", "300001.SZ", "688001.SH"]
    data[("daily", trade_date)] = [bar(code, trade_date) for code in traded_codes]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"}
        for code in [*traded_codes, "600806.SH"]
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / "dataset", dataset_id="kunming-machine-suspension",
        source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")

        result = builder.sync_daily_partition(trade_date)

        assert result["dailyBars"] == 3
        assert ds.listing_status_explanations(trade_date) == {
            "SH.600806": ["SUSPENDED_LISTING"]
        }


def test_historical_jien_nickel_listing_suspension_explains_missing_daily(tmp_path):
    data = responses()
    data[("stock_basic", "D")] = [
        {
            **stock("600432.SH", "Jien Nickel", "主板", "SSE", "20030905"),
            "list_status": "D",
            "delist_date": "20180713",
        }
    ]
    trade_date = "20170526"
    traded_codes = ["000001.SZ", "300001.SZ", "688001.SH"]
    data[("daily", trade_date)] = [bar(code, trade_date) for code in traded_codes]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"}
        for code in [*traded_codes, "600432.SH"]
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / "dataset", dataset_id="jien-nickel-suspension",
        source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")

        result = builder.sync_daily_partition(trade_date)

        assert result["dailyBars"] == 3
        assert ds.listing_status_explanations(trade_date) == {
            "SH.600432": ["SUSPENDED_LISTING"]
        }


def test_historical_xintan_listing_suspension_explains_missing_daily(tmp_path):
    data = responses()
    data[("stock_basic", "D")] = [
        {
            **stock("000511.SZ", "Xintan", "主板", "SZSE", "19930518"),
            "list_status": "D",
            "delist_date": "20180718",
        }
    ]
    trade_date = "20170706"
    traded_codes = ["000001.SZ", "300001.SZ", "688001.SH"]
    data[("daily", trade_date)] = [bar(code, trade_date) for code in traded_codes]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"}
        for code in [*traded_codes, "000511.SZ"]
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / "dataset", dataset_id="xintan-suspension", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")

        result = builder.sync_daily_partition(trade_date)

        assert result["dailyBars"] == 3
        assert ds.listing_status_explanations(trade_date) == {
            "SZ.000511": ["SUSPENDED_LISTING"]
        }


def test_historical_zhonghe_listing_suspension_explains_missing_daily(tmp_path):
    data = responses()
    data[("stock_basic", "D")] = [
        {
            **stock("002070.SZ", "Zhonghe", "主板", "SZSE", "20061012"),
            "list_status": "D",
            "delist_date": "20190709",
        }
    ]
    trade_date = "20180515"
    traded_codes = ["000001.SZ", "300001.SZ", "688001.SH"]
    data[("daily", trade_date)] = [bar(code, trade_date) for code in traded_codes]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"}
        for code in [*traded_codes, "002070.SZ"]
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / "dataset", dataset_id="zhonghe-suspension", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")

        result = builder.sync_daily_partition(trade_date)

        assert result["dailyBars"] == 3
        assert ds.listing_status_explanations(trade_date) == {
            "SZ.002070": ["SUSPENDED_LISTING"]
        }


@pytest.mark.parametrize(
    ("source_code", "instrument_id", "name", "list_date", "delist_date"),
    [
        ("600401.SH", "SH.600401", "Hareon Solar", "20030924", "20190712"),
        ("600680.SH", "SH.600680", "Shanghai Potevio", "19931018", "20190523"),
    ],
)
def test_2018_shanghai_listing_suspensions_explain_missing_daily(
    tmp_path, source_code, instrument_id, name, list_date, delist_date
):
    data = responses()
    data[("stock_basic", "D")] = [
        {
            **stock(source_code, name, "主板", "SSE", list_date),
            "list_status": "D",
            "delist_date": delist_date,
        }
    ]
    trade_date = "20180529"
    traded_codes = ["000001.SZ", "300001.SZ", "688001.SH"]
    data[("daily", trade_date)] = [bar(code, trade_date) for code in traded_codes]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"}
        for code in [*traded_codes, source_code]
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / f"dataset-{instrument_id}", dataset_id=f"suspension-{instrument_id}",
        source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")

        result = builder.sync_daily_partition(trade_date)

        assert result["dailyBars"] == 3
        assert ds.listing_status_explanations(trade_date) == {
            instrument_id: ["SUSPENDED_LISTING"]
        }


def test_historical_huaze_listing_suspension_explains_missing_daily(tmp_path):
    data = responses()
    data[("stock_basic", "D")] = [
        {
            **stock("000693.SZ", "Huaze", "主板", "SZSE", "19970226"),
            "list_status": "D",
            "delist_date": "20190709",
        }
    ]
    trade_date = "20180713"
    traded_codes = ["000001.SZ", "300001.SZ", "688001.SH"]
    data[("daily", trade_date)] = [bar(code, trade_date) for code in traded_codes]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"}
        for code in [*traded_codes, "000693.SZ"]
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / "dataset", dataset_id="huaze-suspension", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")

        result = builder.sync_daily_partition(trade_date)

        assert result["dailyBars"] == 3
        assert ds.listing_status_explanations(trade_date) == {
            "SZ.000693": ["SUSPENDED_LISTING"]
        }


def test_builder_discards_post_delisting_adjustment_factor(tmp_path):
    data = responses()
    data[("stock_basic", "D")] = [
        {
            **stock("600401.SH", "Delisted Shanghai", "主板", "SSE", "19960118"),
            "list_status": "D",
            "delist_date": "20190315",
        }
    ]
    trade_date = "20190315"
    codes = ["000001.SZ", "300001.SZ", "688001.SH"]
    data[("daily", trade_date)] = [bar(code, trade_date) for code in codes]
    data[("adj_factor", trade_date)] = [
        *({"ts_code": code, "trade_date": trade_date, "adj_factor": "1"} for code in codes),
        {"ts_code": "600401.SH", "trade_date": trade_date, "adj_factor": "2"},
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / "dataset", dataset_id="post-delist-factor", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")
        result = builder.sync_daily_partition(trade_date)
        assert result["discardedPostDelistingAdjustmentFactors"] == 1
        assert (
            ds.db.execute(
                "SELECT COUNT(*) FROM adjustment_factors WHERE instrument_id = 'SH.600401'"
            ).fetchone()[0]
            == 0
        )


def test_builder_discards_future_bse_backfill_from_all_daily_streams(tmp_path):
    data = responses()
    data[("stock_basic", "L")].append(
        stock("920123.BJ", "Future Beijing", "北交所", "BSE", "20240329")
    )
    trade_date = "20211115"
    codes = ["000001.SZ", "300001.SZ", "688001.SH", "920729.BJ"]
    invalid_backfill = {**bar("920123.BJ", trade_date), "pre_close": None}
    data[("daily", trade_date)] = [
        *(bar(code, trade_date) for code in codes),
        invalid_backfill,
    ]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"}
        for code in [*codes, "920123.BJ"]
    ]
    data[("suspend_d", trade_date)] = [
        {
            "ts_code": "920123.BJ",
            "trade_date": trade_date,
            "suspend_type": "S",
            "suspend_timing": None,
        }
    ]

    with MarketDataset(
        tmp_path / "dataset", dataset_id="future-bse-backfill", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")
        result = builder.sync_daily_partition(trade_date)
        assert result["discardedPreListingBseRows"] == 3
        assert result["dailyBars"] == 4


def test_builder_rejects_post_delisting_daily_bar(tmp_path):
    data = responses()
    data[("stock_basic", "D")] = [
        {
            **stock("600401.SH", "Delisted Shanghai", "主板", "SSE", "19960118"),
            "list_status": "D",
            "delist_date": "20190315",
        }
    ]
    trade_date = "20200102"
    codes = ["000001.SZ", "300001.SZ", "688001.SH"]
    data[("daily", trade_date)] = [
        *(bar(code, trade_date) for code in codes),
        bar("600401.SH", trade_date),
    ]
    data[("adj_factor", trade_date)] = [
        {"ts_code": code, "trade_date": trade_date, "adj_factor": "1"} for code in codes
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / "dataset", dataset_id="bad-daily-window", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")
        with pytest.raises(MarketDatasetError, match="DAILY_HAS_OUT_OF_UNIVERSE_INSTRUMENTS"):
            builder.sync_daily_partition(trade_date)


def test_builder_rejects_unclassified_adjustment_factor(tmp_path):
    data = responses()
    data[("stock_basic", "L")].append(
        stock("001999.SZ", "Future Shenzhen", "主板", "SZSE", "20250102")
    )
    trade_date = "20211115"
    codes = ["000001.SZ", "300001.SZ", "688001.SH", "920729.BJ"]
    data[("daily", trade_date)] = [bar(code, trade_date) for code in codes]
    data[("adj_factor", trade_date)] = [
        *({"ts_code": code, "trade_date": trade_date, "adj_factor": "1"} for code in codes),
        {"ts_code": "001999.SZ", "trade_date": trade_date, "adj_factor": "1"},
    ]
    data[("suspend_d", trade_date)] = []

    with MarketDataset(
        tmp_path / "dataset", dataset_id="bad-factor-window", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")
        with pytest.raises(MarketDatasetError, match="ADJUSTMENT_HAS_OUT_OF_UNIVERSE_INSTRUMENTS"):
            builder.sync_daily_partition(trade_date)


def test_builder_rejects_conflicting_alias_duplicate(tmp_path):
    data = responses()
    data[("stock_basic", "L")].append(
        stock("001872.SZ", "Renamed Port", "主板", "SZSE", "19930505")
    )
    current = bar("001872.SZ")
    old = {**bar("000022.SZ"), "close": "10.01"}
    data[("daily", "20260915")] = [
        *data[("daily", "20260915")],
        current,
        old,
    ]
    with MarketDataset(
        tmp_path / "dataset", dataset_id="alias-conflict", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")
        with pytest.raises(MarketDatasetError, match="UPSTREAM_ALIAS_VALUE_CONFLICT"):
            builder.sync_daily_partition("20260915")


def test_builder_rejects_wrong_partition_date_before_writing(tmp_path):
    data = responses()
    data[("daily", "20260915")] = [bar("000001.SZ", "20260912")]
    with MarketDataset(
        tmp_path / "dataset", dataset_id="wrong-date", source="TUSHARE_COMPATIBLE"
    ) as ds:
        builder = MarketDatasetBuilder(FakeClient(data), ds)
        builder.sync_reference("20160101", "20260915")
        with pytest.raises(MarketDatasetError, match="UPSTREAM_PARTITION_DATE_MISMATCH"):
            builder.sync_daily_partition("20260915")
