import datetime as dt
import unittest
import urllib.parse
from zoneinfo import ZoneInfo

from tickflow_data import fetch_daily, fetch_minutes


SHANGHAI = ZoneInfo("Asia/Shanghai")


def compact(date, *, period):
    day = dt.datetime.strptime(date, "%Y%m%d").date()
    moments = (
        [dt.datetime.combine(day, dt.time(15, 0), tzinfo=SHANGHAI)]
        if period == "1d"
        else [
            dt.datetime.combine(
                day,
                dt.time(
                    hour=(
                        (9 * 60 + 35 + index * 5) // 60
                        if index < 24
                        else (13 * 60 + 5 + (index - 24) * 5) // 60
                    ),
                    minute=(
                        (9 * 60 + 35 + index * 5) % 60
                        if index < 24
                        else (13 * 60 + 5 + (index - 24) * 5) % 60
                    ),
                ),
                tzinfo=SHANGHAI,
            )
            for index in range(48)
        ]
    )
    size = len(moments)
    return {
        "timestamp": [int(value.timestamp() * 1000) for value in moments],
        "open": [10.0] * size,
        "high": [10.2] * size,
        "low": [9.9] * size,
        "close": [10.1] * size,
        "volume": [100] * size,
        "amount": [1000.0] * size,
    }


class TickFlowDataTest(unittest.TestCase):
    def test_minutes_use_unadjusted_batched_historical_api(self):
        calls = []

        def load(url, headers):
            calls.append((url, headers))
            return {
                "data": {
                    "600519.SH": compact("20260911", period="5m"),
                    "000001.SZ": compact("20260911", period="5m"),
                },
            }

        result = fetch_minutes(
            ["600519", "000001"],
            "20260911",
            env={"TICKFLOW_API_KEY": "test-key"},
            fetch_json=load,
        )

        self.assertEqual(set(result), {"600519", "000001"})
        self.assertEqual(len(result["600519"]), 48)
        query = urllib.parse.parse_qs(urllib.parse.urlparse(calls[0][0]).query)
        self.assertEqual(query["period"], ["5m"])
        self.assertEqual(query["adjust"], ["none"])
        self.assertEqual(query["count"], ["60"])
        self.assertEqual(calls[0][1]["x-api-key"], "test-key")

    def test_daily_requires_exact_requested_trade_date(self):
        result = fetch_daily(
            ["600519"],
            "20260911",
            env={"TICKFLOW_API_KEY": "test-key"},
            fetch_json=lambda _url, _headers: {
                "data": {"600519.SH": compact("20260910", period="1d")},
            },
        )
        self.assertEqual(result, {})

    def test_incomplete_minutes_fail_closed(self):
        payload = compact("20260911", period="5m")
        for key in payload:
            payload[key] = payload[key][:30]
        result = fetch_minutes(
            ["600519"],
            "20260911",
            env={"TICKFLOW_API_KEY": "test-key"},
            fetch_json=lambda _url, _headers: {
                "data": {"600519.SH": payload},
            },
        )
        self.assertEqual(result, {})

    def test_missing_key_disables_source_without_network_call(self):
        result = fetch_minutes(
            ["600519"],
            "20260911",
            env={},
            fetch_json=lambda *_args: self.fail("network should not be called"),
        )
        self.assertEqual(result, {})


if __name__ == "__main__":
    unittest.main()
