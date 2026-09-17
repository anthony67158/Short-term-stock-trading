import hashlib
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from learning_pipeline import (
    _put_immutable,
    expected_settlement_date,
    train,
    validate_training_view,
)


class LearningPipelineTest(unittest.TestCase):
    def test_immutable_upload_retry_accepts_only_identical_content(self):
        class Conflict(Exception):
            status = 409

        class Stored:
            def __init__(self, payload):
                self.payload = payload

            def read(self):
                return self.payload

        class Bucket:
            def __init__(self, payload):
                self.payload = payload

            def put_object(self, *_args, **_kwargs):
                raise Conflict()

            def get_object(self, _key):
                return Stored(self.payload)

        _put_immutable(Bucket(b"same"), "run/report.json", b"same")
        with self.assertRaisesRegex(RuntimeError, "immutable.*conflict"):
            _put_immutable(Bucket(b"different"), "run/report.json", b"same")

    def test_expected_settlement_date_skips_weekend(self):
        self.assertEqual(
            expected_settlement_date(
                datetime(2026, 9, 21, 17, 15, tzinfo=timezone.utc)
            ),
            "2026-09-21",
        )
        self.assertEqual(
            expected_settlement_date(
                datetime(2026, 9, 20, 17, 15, tzinfo=timezone.utc)
            ),
            "2026-09-18",
        )

    def test_training_view_rejects_stale_date_and_hash_mismatch(self):
        now = datetime(2026, 9, 17, 17, 15, tzinfo=timezone.utc)
        generated_at = int(datetime(
            2026,
            9,
            17,
            9,
            20,
            tzinfo=timezone.utc,
        ).timestamp() * 1000)
        view = {
            "schemaVersion": "learning-training-view.v1",
            "generatedAt": generated_at,
            "date": "2026-09-17",
            "stockPick": [],
            "position": [],
        }
        content_hash = hashlib.sha256(json.dumps(
            view,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()).hexdigest()
        view["contentHash"] = content_hash
        manifest = {
            "schemaVersion": "learning-manifest.v1",
            "generatedAt": generated_at,
            "date": "2026-09-17",
            "viewHash": content_hash,
        }

        validate_training_view(manifest, view, now)

        stale_manifest = {**manifest, "date": "2026-09-16"}
        with self.assertRaisesRegex(RuntimeError, "stale learning manifest"):
            validate_training_view(stale_manifest, view, now)

        invalid_view = {**view, "stockPick": [{"sampleId": "tampered"}]}
        with self.assertRaisesRegex(RuntimeError, "content hash mismatch"):
            validate_training_view(manifest, invalid_view, now)

        before_close = int(datetime(
            2026,
            9,
            17,
            8,
            59,
            tzinfo=timezone.utc,
        ).timestamp() * 1000)
        with self.assertRaisesRegex(RuntimeError, "not generated after close"):
            validate_training_view(
                {**manifest, "generatedAt": before_close},
                view,
                now,
            )

    def test_insufficient_samples_skip_without_model_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            view = root / "view.json"
            output = root / "output"
            view.write_text(json.dumps({
                "schemaVersion": "learning-training-view.v1",
                "stockPick": [{
                    "sampleId": "stock-1",
                    "tradeDate": "2026-09-10",
                    "code": "600000",
                    "rankingScore": 0.8,
                    "returnPctT5": 2.1,
                }],
                "position": [{
                    "sampleId": "position-1",
                    "tradeDate": "2026-09-10",
                    "code": "600001",
                    "expectedNetR": 0.2,
                    "realizedNetR": 0.1,
                }],
            }), encoding="utf-8")

            report = train(view, output)

            self.assertEqual(
                report["stockPick"]["status"],
                "SKIPPED_INSUFFICIENT_MATURED_DATA",
            )
            self.assertEqual(
                report["position"]["status"],
                "SKIPPED_INSUFFICIENT_MATURED_DATA",
            )
            self.assertFalse(report["productionPointerChanged"])
            self.assertEqual(
                report["stockPick"]["training"]["labelVersion"],
                "stock-pick-t5-fee-v2",
            )
            self.assertEqual(
                report["stockPick"]["training"]["data"],
                {
                    "samples": 1,
                    "dates": 1,
                    "startDate": "2026-09-10",
                    "endDate": "2026-09-10",
                    "trainSamples": 0,
                    "testSamples": 1,
                    "trainDates": 0,
                    "testDates": 1,
                },
            )
            self.assertEqual(
                report["position"]["training"]["features"],
                [
                    "actionCode",
                    "referencePrice",
                    "entryPrice",
                    "stopLoss",
                    "takeProfit",
                    "pFill",
                    "pWinGivenFill",
                    "expectedNetR",
                ],
            )
            self.assertEqual(report["stockPick"]["seedMetrics"], [])
            self.assertEqual(report["position"]["artifacts"], [])
            self.assertTrue((output / "report.json").exists())
            self.assertFalse(
                (output / "stock-pick-challenger.pkl").exists()
            )
            self.assertFalse(
                (output / "position-challenger.pkl").exists()
            )


if __name__ == "__main__":
    unittest.main()
