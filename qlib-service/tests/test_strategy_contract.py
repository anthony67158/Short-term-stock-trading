import copy
import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from strategy_contract import strategy_fingerprint, validate_strategy_spec


def valid_strategy():
    value = {
        "schemaVersion": "strategy-spec.v1",
        "strategyId": "test-strategy",
        "entry": {
            "field": "quant.score",
            "op": "GTE",
            "value": 55,
        },
        "score": {
            "method": "WEIGHTED_SUM",
            "weights": {
                "marketScore": 0.4,
                "quantScore": 0.35,
                "upProb": 0.15,
                "expectedReturn": 0.1,
            },
            "normalization": {
                "expectedReturnMin": -5,
                "expectedReturnMax": 5,
            },
        },
        "position": {
            "allocationPct": 50,
            "maxPositions": 2,
            "lotSize": 100,
        },
        "exit": {
            "stopLossPct": 3,
            "takeProfitPct": 6,
            "maxHoldingDays": 5,
        },
        "execution": {
            "entryAt": "NEXT_OPEN",
            "exitAt": "NEXT_OPEN",
            "tPlusOne": True,
            "rejectLimitUpBuy": True,
            "rejectLimitDownSell": True,
            "slippageBps": 5,
            "feePolicy": "A_SHARE_STANDARD_V1",
        },
    }
    value["specVersion"] = strategy_fingerprint(value)
    return value


class StrategyContractTest(unittest.TestCase):
    def test_matches_javascript_fingerprint_for_same_canonical_payload(self):
        value = {
            "schemaVersion": "strategy-spec.v1",
            "strategyId": "test-strategy",
            "entry": {
                "field": "quant.score",
                "op": "GTE",
                "value": 55,
            },
            "execution": {"tPlusOne": True},
            "specVersion": "ignored",
        }

        self.assertEqual(strategy_fingerprint(value), "strategy.acffhx")

    def test_rejects_tampered_strategy_version(self):
        value = valid_strategy()
        value["exit"]["stopLossPct"] = 8

        with self.assertRaisesRegex(ValueError, "specVersion"):
            validate_strategy_spec(value)

    def test_rejects_missing_score_weight_and_zero_normalization_range(self):
        missing_weight = valid_strategy()
        del missing_weight["score"]["weights"]["expectedReturn"]
        missing_weight["score"]["weights"]["marketScore"] += 0.1
        missing_weight["specVersion"] = strategy_fingerprint(missing_weight)
        with self.assertRaisesRegex(ValueError, "weight keys"):
            validate_strategy_spec(missing_weight)

        zero_range = valid_strategy()
        zero_range["score"]["normalization"]["expectedReturnMax"] = -5
        zero_range["specVersion"] = strategy_fingerprint(zero_range)
        with self.assertRaisesRegex(ValueError, "normalization"):
            validate_strategy_spec(zero_range)


if __name__ == "__main__":
    unittest.main()
