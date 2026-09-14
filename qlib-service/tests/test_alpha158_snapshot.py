import io
import json
import unittest

from alpha158_snapshot import (
    ACTIVE_MANIFEST_KEY,
    RESEARCH_MANIFEST_KEY,
    build_alpha158_snapshot,
    load_alpha158_snapshot,
    publish_alpha158_snapshot,
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


def walkforward(*, recent_rank_ic=0.03, overall_rank_ic=0.02):
    return {
        "schemaVersion": "mainboard-alpha158-walkforward.v1",
        "generatedAt": 123,
        "overall": {
            "days": 100,
            "IC": 0.03,
            "RankIC": overall_rank_ic,
            "ICIR": 0.2,
        },
        "folds": [{
            "validationEndDate": "20260910",
            "days": 30,
            "IC": 0.04,
            "RankIC": recent_rank_ic,
            "ICIR": 0.3,
        }],
        "rankings": [
            {
                "date": "20260910",
                "code": f"600{index:03d}",
                "rank": index + 1,
                "score": 1 - index / 1000,
            }
            for index in range(500)
        ],
    }


class Alpha158SnapshotTest(unittest.TestCase):
    def test_builds_active_main_board_snapshot_from_latest_oos_day(self):
        snapshot = build_alpha158_snapshot(
            walkforward(),
            generated_at=456,
        )

        self.assertEqual(snapshot["state"], "ACTIVE")
        self.assertTrue(snapshot["productionEligible"])
        self.assertEqual(snapshot["asOfDate"], "20260910")
        self.assertEqual(snapshot["summary"]["stocks"], 500)
        self.assertGreater(snapshot["reliabilityWeight"], 0)
        self.assertLessEqual(snapshot["reliabilityWeight"], 0.25)
        self.assertEqual(snapshot["stocks"]["600000"]["percentile"], 1)

    def test_negative_recent_rank_ic_keeps_snapshot_in_research(self):
        snapshot = build_alpha158_snapshot(
            walkforward(recent_rank_ic=-0.01),
            generated_at=456,
        )

        self.assertEqual(snapshot["state"], "RESEARCH")
        self.assertFalse(snapshot["productionEligible"])
        self.assertEqual(snapshot["reliabilityWeight"], 0)
        self.assertTrue(snapshot["qualityGate"]["blockers"])

    def test_research_snapshot_never_replaces_active_manifest(self):
        bucket = FakeBucket()
        active = build_alpha158_snapshot(
            walkforward(),
            generated_at=456,
        )
        published = publish_alpha158_snapshot(bucket, active)
        research = build_alpha158_snapshot(
            walkforward(recent_rank_ic=-0.01),
            generated_at=789,
        )
        rejected = publish_alpha158_snapshot(bucket, research)

        self.assertEqual(
            published["promotionDecision"]["action"],
            "PUBLISH",
        )
        self.assertEqual(
            rejected["promotionDecision"]["action"],
            "KEEP_CURRENT",
        )
        self.assertIn(ACTIVE_MANIFEST_KEY, bucket.objects)
        self.assertIn(RESEARCH_MANIFEST_KEY, bucket.objects)
        loaded = load_alpha158_snapshot(bucket)
        self.assertEqual(loaded["modelVersion"], active["modelVersion"])

    def test_active_challenger_must_improve_rank_ic(self):
        bucket = FakeBucket()
        champion = build_alpha158_snapshot(
            walkforward(),
            generated_at=456,
        )
        publish_alpha158_snapshot(bucket, champion)
        unchanged = build_alpha158_snapshot(
            walkforward(),
            generated_at=789,
        )
        manifest = publish_alpha158_snapshot(bucket, unchanged)

        self.assertEqual(
            manifest["promotionDecision"]["action"],
            "KEEP_CURRENT",
        )
        active_manifest = json.loads(
            bucket.objects[ACTIVE_MANIFEST_KEY].decode("utf-8")
        )
        self.assertEqual(
            active_manifest["modelVersion"],
            champion["modelVersion"],
        )


if __name__ == "__main__":
    unittest.main()
