import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SERVICE_ROOT = os.path.join(ROOT, "qlib-service")
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

_SPEC = importlib.util.spec_from_file_location(
    "build_v4_review_outcomes",
    os.path.join(ROOT, "scripts", "build_v4_review_outcomes.py"),
)
builder = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(builder)


def outcome(*, mode="CLOSE", initial_at=100, review_at=200):
    return {
        "maturity": "MATURED",
        "tradeDate": "2026-09-10",
        "mode": mode,
        "code": "600001",
        "context": {},
        "scoreInput": {
            "schemaVersion": builder.SCORE_SCHEMA,
            "asOf": initial_at,
            "factors": {
                name: float(index)
                for index, name in enumerate(builder.INITIAL_NAMES)
            },
        },
        "reviewScoreInput": {
            "schemaVersion": builder.V2_SCHEMA,
            "asOf": review_at,
            "priceContract": {"schemaVersion": "review-price-contract.v1"},
            "priceContractHash": "a" * 64,
            "factors": {
                name: float(index)
                for index, name in enumerate(builder.BASE_NAMES)
            },
        },
    }


def alpha(date, code="600001"):
    return {
        "date": date,
        "code": code,
        "centeredZ": 0.6,
        "percentile": 0.8,
        "rankIc20": 0.12,
        "rankIc60": 0.08,
        "scoreMomentum5": 0.05,
    }


class BuildV4ReviewOutcomesTest(unittest.TestCase):
    def test_main_records_alpha_snapshot_hash_in_output_and_report(self):
        with tempfile.TemporaryDirectory() as directory:
            outcomes_path = os.path.join(directory, "outcomes.json")
            alpha_path = os.path.join(directory, "alpha.json")
            output_path = os.path.join(directory, "v4.json")
            report_path = os.path.join(directory, "report.json")
            with open(outcomes_path, "w", encoding="utf-8") as handle:
                json.dump({"outcomes": [outcome()]}, handle)
            with open(alpha_path, "w", encoding="utf-8") as handle:
                json.dump({"rows": [alpha("20260910")]}, handle)

            with patch.object(
                sys,
                "argv",
                [
                    "build_v4_review_outcomes.py",
                    "--outcomes",
                    outcomes_path,
                    "--alpha-snapshot",
                    alpha_path,
                    "--output",
                    output_path,
                    "--report",
                    report_path,
                ],
            ):
                builder.main()

            expected = builder._sha256_file(alpha_path)
            with open(output_path, encoding="utf-8") as handle:
                output = json.load(handle)
            with open(report_path, encoding="utf-8") as handle:
                report = json.load(handle)

        self.assertEqual(
            output["source"]["alphaSnapshotSha256"],
            expected,
        )
        self.assertEqual(report["alphaSnapshotSha256"], expected)

    def test_close_uses_same_day_alpha_and_emits_176_features(self):
        value, reason = builder.augment_outcome(
            outcome(mode="CLOSE"),
            {("20260910", "600001"): alpha("20260910")},
            ["20260909", "20260910"],
        )

        self.assertIsNone(reason)
        review = value["reviewScoreInput"]
        self.assertEqual(review["schemaVersion"], builder.V4_SCHEMA)
        self.assertEqual(tuple(review["factors"]), builder.FEATURE_NAMES_V4)
        self.assertEqual(len(review["factors"]), 176)
        self.assertEqual(
            review["factors"]["alpha_alphaScorePctRank"],
            0.8,
        )
        self.assertEqual(
            value["context"]["v4Bootstrap"]["alphaAsOfDate"],
            "20260910",
        )

    def test_intraday_uses_previous_day_alpha(self):
        value, reason = builder.augment_outcome(
            outcome(mode="INTRADAY"),
            {
                ("20260909", "600001"): alpha("20260909"),
                ("20260910", "600001"): alpha("20260910"),
            },
            ["20260909", "20260910"],
        )

        self.assertIsNone(reason)
        self.assertEqual(
            value["context"]["v4Bootstrap"]["alphaAsOfDate"],
            "20260909",
        )
        self.assertEqual(
            value["context"]["v4Bootstrap"]["alphaTiming"],
            "PREVIOUS_TRADING_DAY",
        )

    def test_complete_v3_review_input_is_extended_without_reordering(self):
        source = outcome()
        source["reviewScoreInput"]["schemaVersion"] = builder.V3_SCHEMA
        source["reviewScoreInput"]["factors"] = {
            **source["reviewScoreInput"]["factors"],
            **{
                f"initial_{name}": value
                for name, value in source["scoreInput"]["factors"].items()
            },
        }

        value, reason = builder.augment_outcome(
            source,
            {("20260910", "600001"): alpha("20260910")},
            ["20260910"],
        )

        self.assertIsNone(reason)
        self.assertEqual(
            tuple(value["reviewScoreInput"]["factors"]),
            builder.FEATURE_NAMES_V4,
        )
        self.assertEqual(
            value["context"]["v4Bootstrap"]["baseFeatureSchema"],
            builder.V3_SCHEMA,
        )

    def test_missing_alpha_is_neutral_with_missing_masks(self):
        value, reason = builder.augment_outcome(
            outcome(),
            {},
            ["20260910"],
        )

        self.assertIsNone(reason)
        factors = value["reviewScoreInput"]["factors"]
        self.assertEqual(factors["alpha_alphaScoreZ"], 0.0)
        self.assertEqual(factors["alpha_alphaScoreZMissing"], 1.0)
        self.assertEqual(factors["alpha_alphaRankIcMissing"], 1.0)
        self.assertEqual(factors["alpha_alphaScoreMomentumMissing"], 1.0)
        self.assertFalse(value["context"]["v4Bootstrap"]["alphaAvailable"])

    def test_future_initial_snapshot_is_rejected(self):
        value, reason = builder.augment_outcome(
            outcome(initial_at=201, review_at=200),
            {},
            ["20260910"],
        )

        self.assertIsNone(value)
        self.assertEqual(reason, "NON_CAUSAL_TIMESTAMP")


if __name__ == "__main__":
    unittest.main()
