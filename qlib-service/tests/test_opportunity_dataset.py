import json
import os
import sys
import tempfile
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from opportunity_contract import (  # noqa: E402
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
)
from opportunity_dataset import (  # noqa: E402
    build_opportunity_dataset,
    build_opportunity_dataset_file,
    opportunity_dataset_readiness,
)


def score_input(code, as_of, formula_id="FORMULA_A"):
    return {
        "schemaVersion": FEATURE_SCHEMA_VERSION,
        "asOf": as_of,
        "code": code,
        "formulaId": formula_id,
        "factors": {
            name: float(index + 1)
            for index, name in enumerate(FEATURE_NAMES)
        },
    }


def outcome(
    decision_id,
    trade_date,
    fill_status,
    *,
    result="NOT_TRIGGERED",
    net_r=None,
    net_pnl=None,
):
    code = decision_id[-6:]
    return {
        "decisionId": decision_id,
        "tradeDate": trade_date,
        "maturity": "MATURED",
        "outcome": result,
        "fillStatus": fill_status,
        "scoreInput": score_input(
            code,
            1_788_320_000_000,
        ),
        "metrics": (
            {
                "netR": net_r,
                "netPnl": net_pnl,
            }
            if net_r is not None
            else None
        ),
    }


class OpportunityDatasetTest(unittest.TestCase):
    def test_builds_fill_and_conditional_trade_labels(self):
        values = [
            outcome(
                "formula:2026-09-01:close:1505:600001",
                "2026-09-01",
                "NOT_TRIGGERED",
            ),
            outcome(
                "formula:2026-09-02:close:1505:600002",
                "2026-09-02",
                "TRIGGERED_UNFILLED",
                result="LIMIT_UP_UNFILLED",
            ),
            outcome(
                "formula:2026-09-03:close:1505:600003",
                "2026-09-03",
                "FILLED",
                result="TAKE_PROFIT",
                net_r=1.4,
                net_pnl=140,
            ),
            outcome(
                "formula:2026-09-04:close:1505:600004",
                "2026-09-04",
                "FILLED",
                result="STOP_LOSS",
                net_r=-1.1,
                net_pnl=-110,
            ),
        ]

        dataset = build_opportunity_dataset(values)

        self.assertEqual(dataset["X"].shape, (4, len(FEATURE_NAMES)))
        np.testing.assert_array_equal(
            dataset["y_fill"],
            np.asarray([0, 0, 1, 1], dtype=np.int8),
        )
        self.assertTrue(np.isnan(dataset["y_win"][0]))
        self.assertTrue(np.isnan(dataset["y_win"][1]))
        np.testing.assert_array_equal(
            dataset["y_win"][2:],
            np.asarray([1.0, 0.0]),
        )
        np.testing.assert_allclose(
            dataset["y_net_r"][2:],
            np.asarray([1.4, -1.1]),
        )
        self.assertEqual(dataset["summary"]["excluded"], 0)
        self.assertEqual(dataset["summary"]["filled"], 2)

    def test_deduplicates_decisions_and_excludes_invalid_contracts(self):
        valid = outcome(
            "formula:2026-09-01:close:1505:600001",
            "2026-09-01",
            "NOT_TRIGGERED",
        )
        invalid = {
            **outcome(
                "formula:2026-09-02:close:1505:600002",
                "2026-09-02",
                "NOT_TRIGGERED",
            ),
            "scoreInput": None,
        }

        dataset = build_opportunity_dataset([valid, valid, invalid])

        self.assertEqual(dataset["X"].shape[0], 1)
        self.assertEqual(dataset["summary"]["duplicates"], 1)
        self.assertEqual(dataset["summary"]["excluded"], 1)

    def test_readiness_requires_dates_samples_and_both_binary_classes(self):
        dates = np.asarray([
            f"2026-01-{(index % 28) + 1:02d}"
            for index in range(1000)
        ])
        report = opportunity_dataset_readiness({
            "dates": dates,
            "y_fill": np.asarray(
                [0, 1] * 500,
                dtype=np.int8,
            ),
            "y_win": np.asarray(
                [0.0, 1.0] * 500,
                dtype=np.float32,
            ),
            "y_net_r": np.asarray(
                [-1.0, 1.0] * 500,
                dtype=np.float32,
            ),
        }, minimum_dates=20)

        self.assertTrue(report["ready"])
        self.assertEqual(report["samples"], 1000)
        self.assertEqual(report["filled_samples"], 1000)

        report = opportunity_dataset_readiness({
            "dates": dates,
            "y_fill": np.ones(1000, dtype=np.int8),
            "y_win": np.ones(1000, dtype=np.float32),
            "y_net_r": np.ones(1000, dtype=np.float32),
        }, minimum_dates=20)
        self.assertFalse(report["ready"])
        self.assertIn("pFill标签缺少正负两类", report["blockers"])

    def test_dataset_file_is_reproducible_and_contains_no_raw_outcomes(self):
        value = outcome(
            "formula:2026-09-01:close:1505:600001",
            "2026-09-01",
            "FILLED",
            result="TAKE_PROFIT",
            net_r=1,
            net_pnl=100,
        )
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "outcomes.json")
            target = os.path.join(directory, "dataset.npz")
            with open(source, "w", encoding="utf-8") as handle:
                json.dump({"outcomes": [value]}, handle)

            report = build_opportunity_dataset_file(source, target)
            saved = np.load(target, allow_pickle=False)

            self.assertEqual(report["samples"], 1)
            self.assertEqual(saved["X"].shape[0], 1)
            self.assertNotIn("outcomes", saved.files)
            self.assertNotIn("raw", saved.files)


if __name__ == "__main__":
    unittest.main()
