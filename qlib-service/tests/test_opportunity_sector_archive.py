import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from opportunity_sector_archive import (  # noqa: E402
    MANIFEST_KEY,
    build_sector_membership_artifact,
    load_sector_membership,
    normalize_sector_memberships,
    publish_sector_membership,
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
        if headers and headers.get("x-oss-forbid-overwrite") == "true":
            if key in self.values:
                raise RuntimeError("already exists")
        self.values[key] = bytes(payload)

    def get_object(self, key):
        if key not in self.values:
            raise KeyError(key)
        return ObjectResult(self.values[key])


def rows(count=900):
    return [{
        "ts_code": f"{600000 + index:06d}.SH",
        "l1_code": f"801{index % 31:03d}.SI",
        "l1_name": f"行业{index % 31}",
        "in_date": "20200101",
        "out_date": None,
    } for index in range(count)]


class OpportunitySectorArchiveTest(unittest.TestCase):
    def test_normalize_keeps_historical_membership_intervals(self):
        values = normalize_sector_memberships([
            {
                "ts_code": "600001.SH",
                "l1_code": "801780.SI",
                "l1_name": "银行",
                "in_date": "20200101",
                "out_date": "20251231",
            },
            {
                "ts_code": "600001.SH",
                "l1_code": "801780.SI",
                "l1_name": "银行",
                "in_date": "20260101",
                "out_date": None,
            },
        ])

        self.assertEqual(len(values), 2)
        self.assertEqual(values[0]["code"], "600001")
        self.assertEqual(values[1]["inDate"], "20260101")

    def test_publish_and_reload_verified_membership(self):
        artifact = build_sector_membership_artifact(
            rows(),
            generated_at=123,
        )
        self.assertEqual(artifact["summary"]["memberships"], 900)

        bucket = FakeBucket()
        manifest = publish_sector_membership(
            bucket,
            rows(),
            generated_at=123,
        )

        self.assertIn(MANIFEST_KEY, bucket.values)
        self.assertEqual(manifest["summary"]["codes"], 900)
        self.assertEqual(len(load_sector_membership(bucket)), 900)


if __name__ == "__main__":
    unittest.main()
