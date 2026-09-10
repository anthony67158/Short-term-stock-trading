import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from archive_public_market_day import (  # noqa: E402
    archive_latest_public,
    fetch_market_snapshot,
    fetch_public_minute_day,
)
from opportunity_market_archive import (  # noqa: E402
    build_market_day_artifact,
    publish_market_days,
)


class ObjectResult:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return self.payload


class FakeBucket:
    def __init__(self):
        self.values = {}

    def put_object(self, key, payload, headers=None):
        if (
            headers
            and headers.get("x-oss-forbid-overwrite") == "true"
            and key in self.values
        ):
            raise RuntimeError("already exists")
        self.values[key] = bytes(payload)

    def get_object(self, key):
        if key not in self.values:
            raise KeyError(key)
        return ObjectResult(self.values[key])


def daily_rows(date, count=800):
    return [{
        "date": date,
        "code": f"{index:06d}",
        "name": f"股票{index}",
        "open": 10,
        "high": 10.5,
        "low": 9.8,
        "close": 10.2,
        "preClose": 10,
        "volume": 10000,
        "amount": 100_000_000 - index,
        "turnover": 1.2,
        "volumeRatio": 1.1,
        "floatShare": 100_000_000,
        "isSt": False,
    } for index in range(count)]


def fund_rows(date, count=800):
    return [{
        "date": date,
        "code": f"{index:06d}",
        "mainNetYi": 0.1,
        "retailNetYi": -0.1,
        "mainRatio": 1.2,
    } for index in range(count)]


def minute_bars(code, date):
    rows = []
    for index in range(48):
        total = (
            9 * 60 + 35 + index * 5
            if index < 24
            else 13 * 60 + 5 + (index - 24) * 5
        )
        hour, minute = divmod(total, 60)
        rows.append({
            "date": f"{date}{hour:02d}{minute:02d}00",
            "code": code,
            "open": 10,
            "high": 10.2,
            "low": 9.9,
            "close": 10.1,
            "volume": 100,
            "amount": 1000,
            "pre_close": 10,
        })
    return rows


class ArchivePublicMarketDayTest(unittest.TestCase):
    def test_market_snapshot_requires_complete_pagination(self):
        timestamp = 1_788_940_800

        def page(number):
            start = (number - 1) * 100
            rows = [{
                "f2": 10.2,
                "f5": 100,
                "f6": 1_000_000,
                "f8": 1.2,
                "f10": 1.1,
                "f12": f"{index:06d}",
                "f14": f"股票{index}",
                "f15": 10.5,
                "f16": 9.8,
                "f17": 10,
                "f18": 10,
                "f21": 1_020_000_000,
                "f62": 10_000_000,
                "f84": -5_000_000,
                "f184": 1.2,
                "f124": timestamp,
            } for index in range(start, start + 100)]
            return {"data": {"total": 800, "diff": rows}}

        result = fetch_market_snapshot(fetch_page=page, workers=2)

        self.assertEqual(result["date"], "20260909")
        self.assertEqual(len(result["daily"]), 800)
        self.assertEqual(len(result["funds"]), 800)
        self.assertEqual(result["daily"][0]["volume"], 10000)
        self.assertEqual(result["funds"][0]["mainNetYi"], 0.1)

    def test_minute_loader_accepts_complete_eastmoney_day(self):
        rows = [
            [
                item["date"][:8] + " "
                + item["date"][8:10] + ":"
                + item["date"][10:12],
                item["open"],
                item["close"],
                item["high"],
                item["low"],
                item["volume"],
                item["amount"],
            ]
            for item in minute_bars("000001", "20260909")
        ]

        result = fetch_public_minute_day(
            "000001",
            "20260909",
            fetch_json=lambda _url: {"data": {"klines": rows}},
        )

        self.assertEqual(len(result), 48)
        self.assertEqual(result[0]["date"], "20260909093500")

    def test_archive_uses_previous_oss_day_for_causal_universe(self):
        target_bucket = FakeBucket()
        previous = build_market_day_artifact(
            date="20260908",
            daily=daily_rows("20260908"),
            funds=fund_rows("20260908"),
            minutes={
                "date": "20260908",
                "codes": {
                    "000001": minute_bars("000001", "20260908"),
                },
            },
            universe_source_date="20260905",
            requested_codes=1,
        )
        publish_market_days(target_bucket, [previous])

        result = archive_latest_public(
            target_bucket=target_bucket,
            snapshot_loader=lambda: {
                "date": "20260909",
                "daily": daily_rows("20260909"),
                "funds": fund_rows("20260909"),
            },
            minute_loader=minute_bars,
            universe_size=100,
            workers=2,
        )

        self.assertEqual(result["status"], "published")
        self.assertEqual(result["source"], "EASTMONEY_TENCENT_DAILY_INCREMENT")
        self.assertEqual(result["entry"]["universe"]["sourceDate"], "20260908")
        self.assertEqual(result["entry"]["universe"]["coverage"], 1)


if __name__ == "__main__":
    unittest.main()
