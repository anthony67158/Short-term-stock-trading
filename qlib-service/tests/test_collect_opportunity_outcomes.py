import json
import os
import sys
import tempfile
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from collect_opportunity_outcomes import (  # noqa: E402
    collect_opportunity_outcomes,
    collect_to_files,
)


class ObjectResult:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return self.payload


class FakeBucket:
    def __init__(self, values):
        self.values = values

    def list_objects(self, prefix="", marker="", max_keys=1000):
        keys = sorted(
            key for key in self.values
            if key.startswith(prefix) and key > marker
        )
        selected = keys[:max_keys]
        return type("Result", (), {
            "object_list": [
                type("Item", (), {"key": key})
                for key in selected
            ],
            "is_truncated": len(keys) > len(selected),
            "next_marker": selected[-1] if selected else "",
        })()

    def get_object(self, key):
        return ObjectResult(json.dumps(self.values[key]).encode("utf-8"))


def outcome(decision_id, trade_date, maturity="MATURED"):
    return {
        "decisionId": decision_id,
        "tradeDate": trade_date,
        "maturity": maturity,
        "code": decision_id[-6:],
        "scoreInput": None,
    }


class CollectOpportunityOutcomesTest(unittest.TestCase):
    def test_collects_only_requested_date_range_and_stable_order(self):
        prefix = "market/opportunity-radar/v1/outcomes/"
        values = {
            f"{prefix}2026-08-31/close-1505/600003.json": outcome(
                "formula:2026-08-31:close:1505:600003",
                "2026-08-31",
            ),
            f"{prefix}2026-09-01/close-1505/600002.json": outcome(
                "formula:2026-09-01:close:1505:600002",
                "2026-09-01",
            ),
            f"{prefix}2026-09-01/close-1505/600001.json": outcome(
                "formula:2026-09-01:close:1505:600001",
                "2026-09-01",
            ),
        }

        result = collect_opportunity_outcomes(
            FakeBucket(values),
            from_date="2026-09-01",
            to_date="2026-09-02",
        )

        self.assertEqual(
            [item["code"] for item in result],
            ["600001", "600002"],
        )

    def test_builds_export_and_dataset_without_account_data(self):
        prefix = "market/opportunity-radar/v1/outcomes/"
        value = outcome(
            "formula:2026-09-01:close:1505:600001",
            "2026-09-01",
        )
        values = {
            f"{prefix}2026-09-01/close-1505/600001.json": value,
        }
        with tempfile.TemporaryDirectory() as directory:
            export_path = os.path.join(directory, "outcomes.json")
            dataset_path = os.path.join(directory, "dataset.npz")

            report = collect_to_files(
                FakeBucket(values),
                from_date="2026-09-01",
                to_date="2026-09-02",
                export_path=export_path,
                dataset_path=dataset_path,
            )

            self.assertEqual(report["collected"], 1)
            self.assertEqual(report["dataset"]["samples"], 0)
            self.assertTrue(os.path.isfile(export_path))
            self.assertTrue(os.path.isfile(dataset_path))


if __name__ == "__main__":
    unittest.main()
