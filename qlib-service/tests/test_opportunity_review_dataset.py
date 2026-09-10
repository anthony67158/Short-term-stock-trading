import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from opportunity_review_contract import (  # noqa: E402
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    feature_vector,
)
from opportunity_review_dataset import (  # noqa: E402
    build_opportunity_review_dataset,
)


def review_input():
    return {
        "schemaVersion": FEATURE_SCHEMA_VERSION,
        "asOf": 1_788_320_060_000,
        "code": "600001",
        "factors": {
            name: float(index)
            for index, name in enumerate(FEATURE_NAMES)
        },
    }


class OpportunityReviewDatasetTest(unittest.TestCase):
    def test_review_contract_preserves_order(self):
        self.assertEqual(
            feature_vector(review_input()),
            [float(index) for index in range(len(FEATURE_NAMES))],
        )

    def test_dataset_only_accepts_filled_matured_review_paths(self):
        valid = {
            "maturity": "MATURED",
            "fillStatus": "FILLED",
            "tradeDate": "2026-09-01",
            "code": "600001",
            "metrics": {"netR": 1.2},
            "reviewScoreInput": review_input(),
            "exit": {"at": 1_788_406_400_000},
        }
        dataset = build_opportunity_review_dataset([
            valid,
            {
                **valid,
                "code": "600002",
                "fillStatus": "NOT_TRIGGERED",
            },
            {
                **valid,
                "code": "600003",
                "reviewScoreInput": None,
            },
        ])

        self.assertEqual(dataset["summary"]["samples"], 1)
        self.assertEqual(dataset["summary"]["excluded"], 2)
        self.assertEqual(dataset["X"].shape, (1, len(FEATURE_NAMES)))
        self.assertEqual(dataset["y_win"].tolist(), [1])
        self.assertAlmostEqual(float(dataset["y_net_r"][0]), 1.2)


if __name__ == "__main__":
    unittest.main()
