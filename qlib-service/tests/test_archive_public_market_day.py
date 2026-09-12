import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from archive_public_market_day import (  # noqa: E402
    MARKET_ARCHIVE_SETTLE_MS,
    archive_latest_public,
    fetch_market_snapshot,
    fetch_public_minute_day,
)
from opportunity_market_archive import (  # noqa: E402
    build_market_day_artifact,
    load_market_day,
    market_close_ms,
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
    def test_archive_skips_intraday_snapshot_until_market_closes(self):
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
        minute_calls = []

        result = archive_latest_public(
            target_bucket=target_bucket,
            snapshot_loader=lambda: {
                "date": "20260909",
                "daily": daily_rows("20260909"),
                "funds": fund_rows("20260909"),
            },
            minute_loader=lambda code, date: minute_calls.append(
                (code, date)
            ),
            universe_size=100,
            workers=2,
            now_ms=(
                market_close_ms("20260909")
                + MARKET_ARCHIVE_SETTLE_MS
                - 1
            ),
        )

        self.assertEqual(result["status"], "market_open_skipped")
        self.assertEqual(result["date"], "20260909")
        self.assertEqual(result["latestArchiveDate"], "20260908")
        self.assertEqual(minute_calls, [])

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

    def test_market_snapshot_prefers_complete_fuyao_prices(self):
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

        fuyao_rows = {
            f"{index:06d}": {
                "open": 10.8,
                "high": 11.2,
                "low": 10.7,
                "close": 11,
                "preClose": 10.2,
                "volume": 20_000,
                "amount": 220_000,
            }
            for index in range(800)
        }
        result = fetch_market_snapshot(
            fetch_page=page,
            fetch_fuyao=lambda: {
                "date": "20260909",
                "total": 800,
                "coverage": 1,
                "rows": fuyao_rows,
            },
            workers=2,
        )

        self.assertEqual(result["priceSource"], "THS_FUYAO")
        self.assertEqual(result["daily"][0]["close"], 11)
        self.assertEqual(result["daily"][0]["turnover"], 1.2)
        self.assertEqual(result["funds"][0]["mainNetYi"], 0.1)

    def test_market_snapshot_prefers_complete_tickflow_prices(self):
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

        def tickflow(codes, date):
            self.assertEqual(date, "20260909")
            return {
                code: [{
                    "open": 10.8,
                    "high": 11.2,
                    "low": 10.7,
                    "close": 11,
                    "volume": 20_000,
                    "amount": 220_000,
                }]
                for code in codes
            }

        result = fetch_market_snapshot(
            fetch_page=page,
            fetch_tickflow=tickflow,
            fetch_fuyao=lambda: self.fail("扶摇不应在TickFlow完整时调用"),
            tickflow_mode="primary",
            workers=2,
        )

        self.assertEqual(result["priceSource"], "TICKFLOW")
        self.assertEqual(result["daily"][0]["close"], 11)
        self.assertEqual(result["daily"][0]["turnover"], 1.2)
        self.assertEqual(result["funds"][0]["retailNetYi"], -0.05)
        self.assertEqual(
            result["tickflowDiagnostics"]["dailyAgreement"],
            {"compared": 800, "closeMatchRate": 0.0},
        )

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

    def test_archive_uses_tickflow_batch_then_falls_back_only_missing_codes(self):
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
        fallback_calls = []

        def tickflow(codes, date):
            self.assertEqual(date, "20260909")
            return {
                code: minute_bars(code, date)
                for code in codes[:90]
            }

        def fallback(code, date):
            fallback_calls.append(code)
            return minute_bars(code, date)

        result = archive_latest_public(
            target_bucket=target_bucket,
            snapshot_loader=lambda: {
                "date": "20260909",
                "daily": daily_rows("20260909"),
                "funds": fund_rows("20260909"),
                "priceSource": "EASTMONEY",
            },
            minute_loader=fallback,
            batch_minute_loader=tickflow,
            tickflow_mode="primary",
            universe_size=100,
            workers=2,
        )

        self.assertEqual(result["status"], "published")
        self.assertEqual(result["source"], "TICKFLOW_EM_TENCENT_DAILY_INCREMENT")
        self.assertEqual(len(fallback_calls), 10)
        self.assertEqual(result["entry"]["universe"]["coverage"], 1)

    def test_shadow_mode_does_not_publish_tickflow_minutes(self):
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
        fallback_calls = []

        result = archive_latest_public(
            target_bucket=target_bucket,
            snapshot_loader=lambda: {
                "date": "20260909",
                "daily": daily_rows("20260909"),
                "funds": fund_rows("20260909"),
                "priceSource": "EASTMONEY",
                "tickflowDiagnostics": {
                    "mode": "shadow",
                    "dailyCoverage": 1,
                },
            },
            batch_minute_loader=lambda codes, date: {
                code: minute_bars(code, date)
                for code in codes
            },
            minute_loader=lambda code, date: (
                fallback_calls.append(code)
                or minute_bars(code, date)
            ),
            tickflow_mode="shadow",
            universe_size=100,
            workers=2,
        )

        self.assertEqual(result["source"], "EASTMONEY_TENCENT_DAILY_INCREMENT")
        self.assertEqual(len(fallback_calls), 100)
        artifact = load_market_day(target_bucket, "20260909")
        self.assertEqual(
            artifact["sourceDiagnostics"]["tickflow"]["minuteCoverage"],
            1,
        )
        self.assertEqual(
            artifact["sourceDiagnostics"]["tickflow"]["minuteAgreement"],
            {"comparedBars": 4800, "closeMatchRate": 1.0},
        )


if __name__ == "__main__":
    unittest.main()
