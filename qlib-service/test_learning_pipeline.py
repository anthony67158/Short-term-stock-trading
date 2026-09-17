import json
import tempfile
import unittest
from pathlib import Path

from learning_pipeline import train


class LearningPipelineTest(unittest.TestCase):
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
                    "plannedExpectedNetR": 0.2,
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
            self.assertTrue((output / "report.json").exists())
            self.assertFalse(
                (output / "stock-pick-challenger.pkl").exists()
            )
            self.assertFalse(
                (output / "position-challenger.pkl").exists()
            )


if __name__ == "__main__":
    unittest.main()
