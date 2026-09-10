import json
import gzip
import os
import sys
import tempfile
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from opportunity_market_archive import (  # noqa: E402
    MANIFEST_KEY,
    build_market_day_artifact,
    encode_market_day,
    latest_market_day_before,
    load_market_day,
    market_close_ms,
    publish_market_days,
)
from publish_tushare_market_history import (  # noqa: E402
    iter_local_market_artifacts,
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


def rows(date, count, *, funds=False):
    result = []
    for index in range(count):
        code = f"{index:06d}"
        if funds:
            result.append({
                "date": date,
                "code": code,
                "mainNetYi": 0.1,
                "retailNetYi": -0.1,
            })
        else:
            result.append({
                "date": date,
                "code": code,
                "name": f"股票{index}",
                "open": 10,
                "high": 11,
                "low": 9,
                "close": 10.5,
                "preClose": 10,
                "volume": 1000,
                "amount": 100000000,
                "turnover": 1.2,
            })
    return result


def minutes(date, code="000001"):
    values = []
    for index in range(48):
        hour = 9 + (35 + index * 5) // 60
        minute = (35 + index * 5) % 60
        if index >= 25:
            total = 13 * 60 + (index - 24) * 5
            hour, minute = divmod(total, 60)
        values.append({
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
    return {"date": date, "codes": {code: values}}


def artifact(date="20260909"):
    return build_market_day_artifact(
        date=date,
        daily=rows(date, 800),
        funds=rows(date, 500, funds=True),
        minutes=minutes(date),
        universe_source_date="20260908",
        requested_codes=1,
        generated_at=123,
    )


class OpportunityMarketArchiveTest(unittest.TestCase):
    def test_market_close_timestamp_is_stable_beijing_time(self):
        self.assertEqual(market_close_ms("20260909"), 1788940800000)

    def test_builds_deterministic_validated_daily_shard(self):
        value = artifact()
        self.assertEqual(value["summary"]["dailyRows"], 800)
        self.assertEqual(value["summary"]["minuteBars"], 48)
        self.assertEqual(value["universe"]["coverage"], 1)
        self.assertEqual(encode_market_day(value), encode_market_day(value))

    def test_rejects_incomplete_or_invalid_market_data(self):
        with self.assertRaisesRegex(ValueError, "全市场覆盖"):
            build_market_day_artifact(
                date="20260909",
                daily=[],
                funds=[],
                minutes=minutes("20260909"),
            )
        with self.assertRaisesRegex(ValueError, "未来日期"):
            build_market_day_artifact(
                date="20260909",
                daily=rows("20260909", 800),
                funds=rows("20260909", 500, funds=True),
                minutes=minutes("20260909"),
                universe_source_date="20260910",
            )
        broken = minutes("20260909")
        broken["codes"]["000001"] = broken["codes"]["000001"][:20]
        with self.assertRaisesRegex(ValueError, "不完整"):
            build_market_day_artifact(
                date="20260909",
                daily=rows("20260909", 800),
                funds=rows("20260909", 500, funds=True),
                minutes=broken,
            )

    def test_publishes_immutable_shards_and_merges_manifest_by_date(self):
        bucket = FakeBucket()
        first = publish_market_days(bucket, [artifact("20260909")], activated_at=1000)
        self.assertIn(MANIFEST_KEY, bucket.values)
        self.assertEqual(first["manifest"]["summary"]["dates"], 1)

        second = publish_market_days(bucket, [artifact("20260910")], activated_at=2000)
        self.assertEqual(second["manifest"]["summary"]["dates"], 2)
        self.assertEqual(
            [row["date"] for row in second["manifest"]["dates"]],
            ["20260909", "20260910"],
        )
        self.assertEqual(load_market_day(bucket, "20260909")["date"], "20260909")
        self.assertEqual(
            latest_market_day_before(bucket, "20260910")["date"],
            "20260909",
        )

        publish_market_days(bucket, [artifact("20260909")], activated_at=3000)
        objects = [key for key in bucket.values if key.endswith(".json.gz")]
        self.assertEqual(len(objects), 2)

    def test_tampered_shard_fails_closed(self):
        bucket = FakeBucket()
        result = publish_market_days(bucket, [artifact()])
        key = result["published"][0]["key"]
        bucket.values[key] = b"tampered"
        with self.assertRaisesRegex(ValueError, "摘要"):
            load_market_day(bucket, "20260909")

        manifest = json.loads(bucket.values[MANIFEST_KEY])
        manifest["schemaVersion"] = "invalid"
        bucket.values[MANIFEST_KEY] = json.dumps(manifest).encode()
        with self.assertRaisesRegex(ValueError, "manifest"):
            load_market_day(bucket, "20260909")

    def test_local_history_is_streamed_as_day_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            metadata = os.path.join(
                directory, "tushare-metadata", "days",
            )
            minute_dir = os.path.join(directory, "minutes")
            os.makedirs(metadata)
            os.makedirs(minute_dir)
            with gzip.open(
                os.path.join(metadata, "20260908.json.gz"),
                "wt",
                encoding="utf-8",
            ) as handle:
                json.dump({"date": "20260908"}, handle)
            with gzip.open(
                os.path.join(metadata, "20260909.json.gz"),
                "wt",
                encoding="utf-8",
            ) as handle:
                json.dump({
                    "date": "20260909",
                    "daily": rows("20260909", 800),
                    "funds": rows("20260909", 500, funds=True),
                }, handle)
            with gzip.open(
                os.path.join(minute_dir, "20260909.json.gz"),
                "wt",
                encoding="utf-8",
            ) as handle:
                json.dump(minutes("20260909"), handle)

            stream = iter_local_market_artifacts(directory)
            self.assertFalse(isinstance(stream, list))
            item = next(stream)
            self.assertEqual(item["date"], "20260909")
            self.assertEqual(item["universe"]["sourceDate"], "20260908")
            self.assertEqual(
                encode_market_day(item),
                encode_market_day(next(
                    iter_local_market_artifacts(directory),
                )),
            )
            with self.assertRaises(StopIteration):
                next(stream)


if __name__ == "__main__":
    unittest.main()
