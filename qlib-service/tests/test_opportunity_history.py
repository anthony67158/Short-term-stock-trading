import json
import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from opportunity_contract import FEATURE_NAMES  # noqa: E402
from opportunity_history import (  # noqa: E402
    HISTORY_MANIFEST_KEY,
    build_history_artifact,
    load_opportunity_history,
    publish_opportunity_history,
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


def outcome(index, filled, net_r=None):
    return {
        "decisionId": (
            f"formula:2026-06-{index + 1:02d}:close:1510:"
            f"600{index:03d}:IMMEDIATE"
        ),
        "tradeDate": f"2026-06-{index + 1:02d}",
        "maturity": "MATURED",
        "fillStatus": "FILLED" if filled else "NOT_TRIGGERED",
        "scoreInput": {
            "schemaVersion": "opportunity-score-feature.v3",
            "asOf": 1_800_000_000_000 + index,
            "code": f"600{index:03d}",
            "formulaId": "UNKNOWN",
            "factors": {name: float(index) for name in FEATURE_NAMES},
            "dimensions": {
                "playbook": "ACCUMULATION",
                "route": "IMMEDIATE",
            },
        },
        "metrics": (
            {
                "netR": net_r,
                "netPnl": 100 if net_r > 0 else -100,
            }
            if filled else None
        ),
    }


class OpportunityHistoryTest(unittest.TestCase):
    def test_build_publish_and_reload_verified_history(self):
        payload = {
            "outcomes": [
                outcome(1, True, 1.2),
                outcome(2, True, -0.8),
                outcome(3, False),
            ],
        }
        readiness = {
            "minimum_samples": 3,
            "minimum_filled_samples": 2,
            "minimum_dates": 2,
        }
        artifact = build_history_artifact(
            payload,
            generated_at=123,
            readiness=readiness,
        )
        self.assertEqual(artifact["summary"]["samples"], 3)

        bucket = FakeBucket()
        manifest = publish_opportunity_history(
            bucket,
            payload,
            generated_at=123,
            readiness=readiness,
        )
        self.assertIn(HISTORY_MANIFEST_KEY, bucket.values)
        self.assertEqual(manifest["summary"]["filledSamples"], 2)
        self.assertEqual(len(load_opportunity_history(bucket)), 3)

    def test_missing_history_is_empty_and_tampering_fails(self):
        bucket = FakeBucket()
        self.assertEqual(load_opportunity_history(bucket), [])

        bucket.values[HISTORY_MANIFEST_KEY] = json.dumps({
            "schemaVersion": "opportunity-history-manifest.v1",
            "key": "opportunitymodel/training-data/runs/test.json.gz",
            "sha256": "bad",
        }).encode("utf-8")
        bucket.values[
            "opportunitymodel/training-data/runs/test.json.gz"
        ] = b"tampered"
        with self.assertRaisesRegex(ValueError, "摘要"):
            load_opportunity_history(bucket)


if __name__ == "__main__":
    unittest.main()
