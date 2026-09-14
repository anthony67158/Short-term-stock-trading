import gzip
import importlib.util
import json
import os
import sys
import tempfile
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
ROOT = os.path.abspath(os.path.join(SERVICE_ROOT, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from decision_engine.heads.review_contract import (  # noqa: E402
    review_price_contract,
)
from decision_engine.heads.review_contract_v4 import (  # noqa: E402
    FEATURE_NAMES_V4,
    FEATURE_SCHEMA_VERSION_V4,
)
from decision_engine.training.review_dataset import (  # noqa: E402
    load_opportunity_review_dataset,
)


_SPEC = importlib.util.spec_from_file_location(
    "build_v4_review_dataset",
    os.path.join(ROOT, "scripts", "build_v4_review_dataset.py"),
)
builder = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(builder)


def outcome(index):
    contract = review_price_contract({
        "entryPrice": 10.2,
        "stopPrice": 9.8,
        "feeRateBps": 6.1,
        "slippageBps": 5,
        "lotSize": 100,
        "tPlusOne": True,
        "exitPolicyVersion": "trailing-exit.v1",
        "observationPolicyVersion": "trigger-review-observation.v1",
    })
    return {
        "decisionId": f"formula:test:{index}",
        "code": f"60000{index}",
        "tradeDate": f"2026-09-0{index}",
        "maturity": "MATURED",
        "fillStatus": "FILLED",
        "evaluatedAt": 3_000 + index,
        "reviewScoreInput": {
            "schemaVersion": FEATURE_SCHEMA_VERSION_V4,
            "asOf": 1_000 + index,
            "code": f"60000{index}",
            "priceContract": contract["canonical"],
            "priceContractHash": contract["hash"],
            "factors": {
                name: float(position)
                for position, name in enumerate(FEATURE_NAMES_V4)
            },
        },
        "entry": {
            "at": 2_000 + index,
            "quantity": 100,
            "grossAmount": 1_020,
        },
        "exit": {
            "at": 3_000 + index,
            "grossAmount": 1_040,
        },
        "metrics": {"netPnl": 20},
        "labelSource": "HISTORICAL_SIMULATION",
        "exitContractVersion": "trailing-exit.v1",
        "context": {"sectorPhase": "STARTUP"},
    }


class BuildV4ReviewDatasetTest(unittest.TestCase):
    def test_builds_audited_npz_from_chunk_archives(self):
        with tempfile.TemporaryDirectory() as directory:
            chunks = []
            for index in (1, 2):
                chunk = os.path.join(directory, f"chunk-{index:02d}")
                os.makedirs(chunk)
                with gzip.open(
                    os.path.join(
                        chunk,
                        "opportunity-outcomes-v4.json.gz",
                    ),
                    "wt",
                    encoding="utf-8",
                ) as handle:
                    json.dump({"outcomes": [outcome(index)]}, handle)
                with gzip.open(
                    os.path.join(chunk, "daily.json.gz"),
                    "wt",
                    encoding="utf-8",
                ) as handle:
                    json.dump([{
                        "date": f"2026090{index}",
                        "code": f"60000{index}",
                        "close": 10.2,
                        "preClose": 10.1,
                    }], handle)
                chunks.append({"index": index})
            with open(
                os.path.join(directory, "plan.json"),
                "w",
                encoding="utf-8",
            ) as handle:
                json.dump({"chunks": chunks}, handle)
            output = os.path.join(directory, "review-v4.npz")

            audit = builder.build_dataset(directory, output)
            dataset = load_opportunity_review_dataset(output)

            self.assertEqual(audit["sourceChunks"], 2)
            self.assertEqual(audit["featureCount"], len(FEATURE_NAMES_V4))
            self.assertEqual(audit["events"], 2)
            self.assertEqual(audit["conditionalSamples"], 2)
            self.assertEqual(audit["stress10Coverage"], 1.0)
            self.assertEqual(dataset["X"].shape, (2, len(FEATURE_NAMES_V4)))
            self.assertTrue(os.path.isfile(
                os.path.join(directory, "review-v4.audit.json"),
            ))

    def test_detects_corporate_action_inside_event_holding_window(self):
        actions = builder._corporate_action_keys([
            {
                "date": "20260413",
                "code": "605369",
                "close": 82.5,
                "preClose": 84.99,
            },
            {
                "date": "20260414",
                "code": "605369",
                "close": 55.9,
                "preClose": 57.64,
            },
        ])
        value = {
            "code": "605369",
            "tradeDate": "20260413",
            "exit": {"tradeDate": "20260414"},
        }

        self.assertTrue(builder._crosses_corporate_action(value, actions))
        self.assertFalse(builder._crosses_corporate_action(
            {**value, "exit": {"tradeDate": "20260413"}},
            actions,
        ))


if __name__ == "__main__":
    unittest.main()
