import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from decision_engine.heads.review_contract import (  # noqa: E402
    REVIEW_PRICE_CONTRACT_SCHEMA_VERSION,
    review_price_contract,
)


class ReviewPriceContractTest(unittest.TestCase):
    def input(self):
        return {
            "stopPrice": 9.8,
            "entryPrice": 10.2,
            "feeRateBps": 6.1,
            "slippageBps": 5,
            "lotSize": 100,
            "tPlusOne": True,
            "exitPolicyVersion": "trailing-exit.v1",
            "observationPolicyVersion": "trigger-review-observation.v1",
        }

    def test_matches_cross_language_golden_hash(self):
        actual = review_price_contract(self.input())
        self.assertEqual(
            actual["canonical"]["schemaVersion"],
            REVIEW_PRICE_CONTRACT_SCHEMA_VERSION,
        )
        self.assertEqual(actual["canonical"]["priceRiskMilliCny"], 400)
        self.assertEqual(
            actual["hash"],
            "f9ad80382299d84f729524a924796ee3ac7a18081f1f0e1618db7affe670fab9",
        )

    def test_rejects_invalid_contracts(self):
        for patch in (
            {"entryPrice": 9.8},
            {"stopPrice": float("nan")},
            {"feeRateBps": -1},
            {"slippageBps": float("inf")},
            {"lotSize": 0},
            {"tPlusOne": "true"},
            {"exitPolicyVersion": "../bad"},
            {"observationPolicyVersion": ""},
        ):
            value = {**self.input(), **patch}
            with self.assertRaises(ValueError):
                review_price_contract(value)


if __name__ == "__main__":
    unittest.main()
