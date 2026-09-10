import datetime as dt
import os
import sys
import unittest
from zoneinfo import ZoneInfo


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from archive_tushare_market_day import (  # noqa: E402
    completed_trade_dates,
    minute_payload,
    select_causal_universe,
    stable_hash,
)


def universe_rows(count=120):
    return [{
        "code": f"{index:06d}",
        "name": f"股票{index}",
        "close": 10,
        "amount": 100_000_000 - index,
        "turnover": 1.2,
        "isSt": False,
    } for index in range(count)]


def minute_rows(code, date, *, zero=False):
    values = []
    times = [
        *(f"{hour:02d}:{minute:02d}:00"
          for hour, minute in (
              (9 + (35 + offset * 5) // 60, (35 + offset * 5) % 60)
              for offset in range(24)
          )),
        *(f"{hour:02d}:{minute:02d}:00"
          for hour, minute in (
              divmod(13 * 60 + 5 + offset * 5, 60)
              for offset in range(24)
          )),
    ]
    for value in times:
        values.append({
            "ts_code": f"{code}.SZ",
            "trade_time": f"{date[:4]}-{date[4:6]}-{date[6:]} {value}",
            "open": 0 if zero else 10,
            "high": 0 if zero else 10.2,
            "low": 0 if zero else 9.9,
            "close": 0 if zero else 10.1,
            "vol": 0 if zero else 100,
            "amount": 0 if zero else 1000,
        })
    return values


class FakeClient:
    def rows(self, _api_name, params, _fields):
        code = params["ts_code"].split(".")[0]
        date = params["start_date"].replace("-", "")[:8]
        return minute_rows(code, date, zero=code == "000002")


class SparseClient(FakeClient):
    def rows(self, _api_name, params, _fields):
        code = params["ts_code"].split(".")[0]
        date = params["start_date"].replace("-", "")[:8]
        return minute_rows(code, date, zero=code != "000001")


class ArchiveTushareMarketDayTest(unittest.TestCase):
    def test_hash_matches_javascript_fnv_and_universe_is_deterministic(self):
        self.assertEqual(stable_hash("20260909:600519"), 20551284)
        rows = universe_rows()
        first = select_causal_universe(rows, "20260909", limit=100)
        second = select_causal_universe(rows, "20260909", limit=100)
        other = select_causal_universe(rows, "20260910", limit=100)
        self.assertEqual(first, second)
        self.assertEqual(len(first), 100)
        self.assertTrue(set(f"{index:06d}" for index in range(80)).issubset(first))
        self.assertNotEqual(first, other)

    def test_latest_day_is_previous_completed_session(self):
        calendar = [
            {"cal_date": "20260904", "is_open": 1},
            {"cal_date": "20260907", "is_open": 1},
            {"cal_date": "20260908", "is_open": 1},
            {"cal_date": "20260909", "is_open": 1},
        ]
        now = dt.datetime(2026, 9, 9, 1, 15, tzinfo=ZoneInfo("Asia/Shanghai"))
        self.assertEqual(
            completed_trade_dates(calendar, now=now),
            ["20260904", "20260907", "20260908"],
        )

    def test_minute_payload_excludes_suspension_and_checks_coverage(self):
        payload, excluded = minute_payload(
            FakeClient(),
            "20260909",
            [f"{index:06d}" for index in range(1, 101)],
        )
        self.assertEqual(len(payload["codes"]), 99)
        self.assertEqual(excluded, ["000002"])
        with self.assertRaisesRegex(ValueError, "覆盖率"):
            minute_payload(
                SparseClient(),
                "20260909",
                [f"{index:06d}" for index in range(1, 11)],
            )


if __name__ == "__main__":
    unittest.main()
