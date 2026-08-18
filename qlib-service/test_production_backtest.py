import unittest
from types import SimpleNamespace

import numpy as np

from production_backtest import (
    HARD_ERROR_MEMORY_KEY,
    PRODUCTION_ACCURACY_KEY,
    collect_hard_error_samples,
    evaluate_production_model,
    load_hard_error_memory,
    merge_hard_error_memory,
    upload_hard_error_memory,
    upload_production_accuracy,
)


class FakeBooster:
    def __init__(self, probabilities):
        self.probabilities = np.asarray(probabilities, dtype=float)
        self.seen_rows = None

    def predict(self, rows):
        self.seen_rows = np.asarray(rows)
        return self.probabilities[-len(rows):]


class FakeBucket:
    def __init__(self):
        self.writes = []

    def put_object(self, key, payload, headers=None):
        self.writes.append((key, payload, headers))


class FakeReadBucket(FakeBucket):
    def __init__(self, payload=None):
        super().__init__()
        self.payload = payload

    def get_object(self, key):
        if self.payload is None:
            error = RuntimeError("missing")
            error.status = 404
            raise error
        return SimpleNamespace(
            read=lambda: self.payload,
        )


class ProductionBacktestTest(unittest.TestCase):
    def test_collects_only_forward_misclassifications_without_raw_features(self):
        booster = FakeBooster([0.9, 0.8, 0.2, 0.7])
        samples = collect_hard_error_samples(
            booster,
            {
                "trained_at": 1786593727,
                "data_end_date": "2026-08-06",
            },
            X=np.arange(8, dtype=float).reshape(4, 2),
            labels=np.array([1, 0, 0, 0]),
            dates=np.array([
                "20260805",
                "20260807",
                "20260807",
                "20260810",
            ]),
            codes=np.array(["sh000001", "sh000002", "sh000003", "sh000004"]),
            now=123,
        )

        self.assertEqual(
            [sample["sampleKey"] for sample in samples],
            ["20260807:sh000002", "20260810:sh000004"],
        )
        self.assertEqual(samples[0]["label"], 0)
        self.assertEqual(samples[0]["predicted"], 1)
        self.assertEqual(samples[0]["modelTrainedAt"], 1786593727)
        self.assertEqual(samples[0]["timesSeen"], 1)
        self.assertNotIn("features", samples[0])
        self.assertNotIn("candles", samples[0])

    def test_hard_error_memory_deduplicates_and_keeps_balanced_recent_replay(self):
        existing = {
            "schemaVersion": "production-hard-errors.v1",
            "samples": [{
                "sampleKey": "20260807:sh000002",
                "date": "20260807",
                "code": "sh000002",
                "label": 0,
                "probability": 0.8,
                "predicted": 1,
                "confidence": 0.6,
                "modelTrainedAt": 1,
                "firstSeenAt": 100,
                "lastSeenAt": 100,
                "timesSeen": 1,
            }],
        }
        incoming = [
            {
                "sampleKey": "20260807:sh000002",
                "date": "20260807",
                "code": "sh000002",
                "label": 0,
                "probability": 0.9,
                "predicted": 1,
                "confidence": 0.8,
                "modelTrainedAt": 2,
                "firstSeenAt": 200,
                "lastSeenAt": 200,
                "timesSeen": 1,
            },
            *[
                {
                    "sampleKey": f"20260810:sh00010{index}",
                    "date": "20260810",
                    "code": f"sh00010{index}",
                    "label": index % 2,
                    "probability": 0.9 if index % 2 == 0 else 0.1,
                    "predicted": 1 - index % 2,
                    "confidence": 0.8,
                    "modelTrainedAt": 2,
                    "firstSeenAt": 200,
                    "lastSeenAt": 200,
                    "timesSeen": 1,
                }
                for index in range(6)
            ],
        ]

        memory = merge_hard_error_memory(
            existing,
            incoming,
            now=300,
            max_samples=4,
            max_per_class=2,
        )

        self.assertEqual(memory["schemaVersion"], "production-hard-errors.v1")
        self.assertEqual(memory["total"], 4)
        self.assertEqual(memory["byClass"], {"0": 2, "1": 2})
        updated = next(
            sample for sample in memory["samples"]
            if sample["sampleKey"] == "20260807:sh000002"
        )
        self.assertEqual(updated["firstSeenAt"], 100)
        self.assertEqual(updated["lastSeenAt"], 300)
        self.assertEqual(updated["timesSeen"], 2)
        self.assertEqual(updated["probability"], 0.9)

    def test_only_mature_samples_after_champion_cutoff_count_as_actual_accuracy(self):
        booster = FakeBooster([0.1, 0.8, 0.7, 0.2, 0.4])
        report = evaluate_production_model(
            booster,
            {
                "trained_at": 1786593727,
                "data_end_date": "2026-08-06",
                "horizon": 5,
                "target_rule": "future_max_high >= dynamic_target",
                "feat_names": ["mom5", "rsi"],
            },
            X=np.arange(10, dtype=float).reshape(5, 2),
            labels=np.array([1, 1, 0, 0, 0]),
            dates=np.array([
                "20260805",
                "20260807",
                "20260807",
                "20260810",
                "20260810",
            ]),
            codes=np.array(["sh000001", "sh000002", "sh000003", "sh000004", "sh000005"]),
            next_up_probabilities=np.array([0.9, 0.6, 0.4, 0.55, 0.45]),
            next_actual_up=np.array([1, 1, 0, 0, 1]),
            next_range_hit=np.array([1, 1, 0, 1, 1]),
            now=123,
        )

        self.assertEqual(booster.seen_rows.shape, (4, 2))
        self.assertEqual(report["schemaVersion"], "production-accuracy.v1")
        self.assertEqual(report["mode"], "forwardUnseenBacktest")
        self.assertEqual(report["model"]["dataEndDate"], "2026-08-06")
        self.assertEqual(report["overall"], {
            "total": 4,
            "correct": 3,
            "accuracyPct": 75.0,
            "balancedAccuracyPct": 83.3,
        })
        self.assertEqual(report["strongSignals"], {
            "total": 3,
            "correct": 2,
            "accuracyPct": 66.7,
            "coveragePct": 75.0,
            "positiveThresholdPct": 62,
            "negativeThresholdPct": 38,
        })
        self.assertEqual(report["nextTradeDayDirection"], {
            "total": 4,
            "correct": 2,
            "accuracyPct": 50.0,
        })
        self.assertEqual(report["nextTradeDayRange"], {
            "total": 4,
            "covered": 3,
            "coveragePct": 75.0,
            "nominalCoveragePct": 80,
        })
        self.assertEqual(report["days"], [
            {"date": "2026-08-10", "total": 2, "correct": 2, "accuracyPct": 100.0},
            {"date": "2026-08-07", "total": 2, "correct": 1, "accuracyPct": 50.0},
        ])
        self.assertEqual(report["sampleWindow"], {
            "from": "2026-08-07",
            "to": "2026-08-10",
            "tradingDates": 2,
        })
        self.assertEqual(report["updatedAt"], 123)

    def test_no_forward_samples_returns_empty_report_without_in_sample_accuracy(self):
        report = evaluate_production_model(
            FakeBooster([0.8, 0.7]),
            {
                "trained_at": 1,
                "data_end_date": "2026-08-06",
                "horizon": 5,
                "feat_names": ["mom5"],
            },
            X=np.array([[1.0], [2.0]]),
            labels=np.array([1, 0]),
            dates=np.array(["20260805", "20260806"]),
            codes=np.array(["sh000001", "sh000002"]),
            next_up_probabilities=np.array([0.6, 0.4]),
            next_actual_up=np.array([1, 0]),
            next_range_hit=np.array([1, 1]),
            now=456,
        )

        self.assertEqual(report["overall"]["total"], 0)
        self.assertIsNone(report["overall"]["accuracyPct"])
        self.assertEqual(report["nextTradeDayDirection"]["total"], 0)
        self.assertEqual(report["nextTradeDayRange"]["total"], 0)
        self.assertEqual(report["days"], [])
        self.assertEqual(report["sampleWindow"]["tradingDates"], 0)

    def test_accuracy_report_uploads_to_stable_oss_key(self):
        bucket = FakeBucket()
        report = {"schemaVersion": "production-accuracy.v1", "overall": {"total": 2}}

        upload_production_accuracy(report, bucket=bucket)

        self.assertEqual(bucket.writes[0][0], PRODUCTION_ACCURACY_KEY)
        self.assertIn(b'"schemaVersion": "production-accuracy.v1"', bucket.writes[0][1])
        self.assertEqual(
            bucket.writes[0][2],
            {"Content-Type": "application/json", "Cache-Control": "no-cache"},
        )

    def test_hard_error_memory_uploads_to_its_own_stable_key(self):
        bucket = FakeBucket()
        memory = {
            "schemaVersion": "production-hard-errors.v1",
            "samples": [],
        }

        upload_hard_error_memory(memory, bucket=bucket)

        self.assertEqual(bucket.writes[0][0], HARD_ERROR_MEMORY_KEY)
        self.assertIn(b"production-hard-errors.v1", bucket.writes[0][1])

    def test_hard_error_memory_loads_existing_oss_state_and_tolerates_first_run(self):
        payload = b'{"schemaVersion":"production-hard-errors.v1","samples":[]}'
        loaded = load_hard_error_memory(bucket=FakeReadBucket(payload))
        missing = load_hard_error_memory(bucket=FakeReadBucket())

        self.assertEqual(loaded["schemaVersion"], "production-hard-errors.v1")
        self.assertEqual(loaded["samples"], [])
        self.assertEqual(missing["samples"], [])


if __name__ == "__main__":
    unittest.main()
