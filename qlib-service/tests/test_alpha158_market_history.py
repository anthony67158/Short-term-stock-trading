import gzip
import hashlib
import io
import json
import os
import tempfile
import unittest

from alpha158_market_history import (
    MANIFEST_KEY,
    append_alpha158_market_day,
    export_alpha158_daily_history,
    publish_alpha158_daily_shards,
)


class FakeBucket:
    def __init__(self):
        self.objects = {}

    def put_object(self, key, payload, headers=None):
        if (
            (headers or {}).get("x-oss-forbid-overwrite") == "true"
            and key in self.objects
        ):
            error = RuntimeError(key)
            error.status = 409
            raise error
        self.objects[key] = bytes(payload)

    def get_object(self, key):
        if key not in self.objects:
            error = KeyError(key)
            error.status = 404
            raise error
        return io.BytesIO(self.objects[key])


def rows(date, count=5):
    return [
        {
            "date": date,
            "code": f"600{index:03d}",
            "name": f"股票{index}",
            "open": 10,
            "high": 10.5,
            "low": 9.8,
            "close": 10.2,
            "preClose": 10,
            "volume": 100_000,
            "amount": 100_000_000,
            "turnover": 2,
        }
        for index in range(count)
    ]


class Alpha158MarketHistoryTest(unittest.TestCase):
    def test_publishes_immutable_daily_shards_and_manifest(self):
        bucket = FakeBucket()
        source = [
            *rows("20260910"),
            *rows("20260911"),
            {
                **rows("20260911")[0],
                "code": "300001",
            },
        ]
        result = publish_alpha158_daily_shards(
            bucket,
            source,
            minimum_rows=5,
            activated_at=123,
        )

        self.assertEqual(result["manifest"]["summary"]["dates"], 2)
        self.assertEqual(result["manifest"]["summary"]["rows"], 10)
        self.assertIn(MANIFEST_KEY, bucket.objects)
        for entry in result["manifest"]["dates"]:
            encoded = bucket.objects[entry["key"]]
            self.assertEqual(
                hashlib.sha256(encoded).hexdigest(),
                entry["sha256"],
            )
            shard = json.loads(gzip.decompress(encoded))
            self.assertTrue(all(
                row["code"].startswith("600")
                for row in shard["rows"]
            ))

    def test_append_and_export_preserve_all_trading_days(self):
        bucket = FakeBucket()
        publish_alpha158_daily_shards(
            bucket,
            rows("20260910"),
            minimum_rows=5,
        )
        append_alpha158_market_day(bucket, {
            "daily": rows("20260911"),
        }, minimum_rows=5)

        with tempfile.TemporaryDirectory() as directory:
            output = os.path.join(directory, "daily.json.gz")
            report = export_alpha158_daily_history(
                bucket,
                output,
                minimum_days=2,
            )
            with gzip.open(output, "rt", encoding="utf-8") as handle:
                exported = json.load(handle)

        self.assertEqual(report["dates"], 2)
        self.assertEqual(report["rows"], 10)
        self.assertEqual(
            sorted({row["date"] for row in exported}),
            ["20260910", "20260911"],
        )

    def test_export_rejects_corrupted_shard(self):
        bucket = FakeBucket()
        result = publish_alpha158_daily_shards(
            bucket,
            rows("20260910"),
            minimum_rows=5,
        )
        bucket.objects[result["manifest"]["dates"][0]["key"]] = b"corrupt"

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "摘要不匹配"):
                export_alpha158_daily_history(
                    bucket,
                    os.path.join(directory, "daily.json.gz"),
                    minimum_days=1,
                )


if __name__ == "__main__":
    unittest.main()
