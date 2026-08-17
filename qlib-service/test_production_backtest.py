import unittest

import numpy as np

from production_backtest import (
    PRODUCTION_ACCURACY_KEY,
    evaluate_production_model,
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


class ProductionBacktestTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
