import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import unittest

from opportunity_pattern_snapshot import (
    MANIFEST_KEY,
    SCHEMA_VERSION,
    build_strategy_pattern_snapshot,
    load_strategy_pattern_snapshot,
    publish_strategy_pattern_snapshot,
    strategy_pattern_scores,
)


class FakeBucket:
    def __init__(self):
        self.objects = {}

    def put_object(self, key, content, headers=None):
        if headers and headers.get("x-oss-forbid-overwrite") == "true":
            if key in self.objects:
                error = RuntimeError("conflict")
                error.status = 409
                raise error
        self.objects[key] = bytes(content)

    def get_object(self, key):
        if key not in self.objects:
            error = KeyError(key)
            error.status = 404
            raise error

        class Result:
            def __init__(self, content):
                self.content = content

            def read(self):
                return self.content

        return Result(self.objects[key])


def bars(count=61, code="600001"):
    rows = []
    for index in range(count):
        close = 10 + index * 0.02
        rows.append({
            "date": f"2026{index + 1:04d}",
            "code": code,
            "open": close - 0.02,
            "high": close + 0.08,
            "low": close - 0.08,
            "close": close,
            "volume": 1_000,
        })
    return rows


class StrategyPatternSnapshotTest(unittest.TestCase):
    def test_node_python_scores_match_for_missing_and_suspended_sessions(self):
        mapping = {
            "historyCoverage": "patternHistoryCoverage",
            "platformBreakout": "patternPlatformBreakoutScore",
            "supportPullback": "patternSupportPullbackScore",
            "volumePriceSurge": "patternVolumePriceSurgeScore",
            "lowerShadowReversal": "patternLowerShadowReversalScore",
            "lowVolTrend": "patternLowVolTrendScore",
        }
        cases = [bars(), bars(10), bars(30), bars()]
        cases[-1][-1]["volume"] = 0
        cases[2][-2]["volume"] = None
        script = """
import {readFileSync} from 'node:fs';
import {buildStrategyPatternFeatures} from './shared/strategyPatternFeatures.js';
console.log(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(
  candles => buildStrategyPatternFeatures({candles,mode:'close'}))));
"""
        output = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=Path(__file__).resolve().parents[2],
            input=json.dumps(cases), text=True, capture_output=True,
            check=True, timeout=15,
        )
        for rows, node in zip(cases, json.loads(output.stdout)):
            python = strategy_pattern_scores(rows)
            for key, feature in mapping.items():
                self.assertAlmostEqual(python[key], node[feature], places=5)

    def test_scores_low_volatility_trend_with_full_history(self):
        result = strategy_pattern_scores(bars())

        self.assertEqual(result["historyCoverage"], 1)
        self.assertGreaterEqual(result["lowVolTrend"], 70)
        self.assertTrue(all(
            isinstance(value, (int, float))
            for value in result.values()
        ))

    def test_build_snapshot_keeps_latest_market_universe(self):
        rows = bars()
        artifacts = []
        for index, row in enumerate(rows):
            daily = [row]
            if index == len(rows) - 1:
                daily.extend({
                    **row,
                    "code": f"{code:06d}",
                } for code in range(1, 800))
            artifacts.append({
                "schemaVersion": "opportunity-market-day.v1",
                "date": row["date"],
                "daily": daily,
            })

        snapshot = build_strategy_pattern_snapshot(
            artifacts,
            generated_at=123,
        )

        self.assertEqual(snapshot["schemaVersion"], SCHEMA_VERSION)
        self.assertEqual(snapshot["asOfDate"], rows[-1]["date"])
        self.assertEqual(snapshot["summary"]["stocks"], 800)
        self.assertEqual(snapshot["stocks"]["600001"]["historyCoverage"], 1)

    def test_publish_and_load_verifies_checksum(self):
        bucket = FakeBucket()
        entries = []
        for row in bars():
            artifact = {
                "schemaVersion": "opportunity-market-day.v1",
                "date": row["date"],
                "daily": [
                    {**row, "code": f"{code:06d}"}
                    for code in range(1, 801)
                ],
            }
            encoded = gzip.compress(
                json.dumps(artifact, separators=(",", ":")).encode(),
                mtime=0,
            )
            digest = hashlib.sha256(encoded).hexdigest()
            key = f"market/{row['date']}.json.gz"
            bucket.objects[key] = encoded
            entries.append({
                "date": row["date"],
                "key": key,
                "sha256": digest,
            })
        manifest = {
            "schemaVersion": "opportunity-market-manifest.v1",
            "dates": entries,
        }

        published = publish_strategy_pattern_snapshot(bucket, manifest)
        loaded = load_strategy_pattern_snapshot(bucket)

        self.assertIn(MANIFEST_KEY, bucket.objects)
        self.assertEqual(loaded["asOfDate"], published["asOfDate"])
        self.assertEqual(loaded["summary"]["stocks"], 800)


if __name__ == "__main__":
    unittest.main()
