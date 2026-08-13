import copy
import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from strategy_candidate_catalog import build_candidate_catalog
from strategy_contract import strategy_fingerprint


def base_strategy():
    value = {
        "schemaVersion": "strategy-spec.v1",
        "strategyId": "candidate-test",
        "entry": {
            "type": "ALL",
            "conditions": [
                {"field": "marketScore", "op": "GTE", "value": 55},
                {"field": "quant.score", "op": "GTE", "value": 55},
            ],
        },
        "score": {
            "method": "WEIGHTED_SUM",
            "weights": {
                "marketScore": 0.4,
                "quantScore": 0.35,
                "upProb": 0.15,
                "expectedReturn": 0.1,
            },
            "bonuses": {"highConfidence": 5},
            "normalization": {
                "expectedReturnMin": -5,
                "expectedReturnMax": 5,
            },
        },
        "position": {
            "sizing": "EQUAL_WEIGHT",
            "allocationPct": 20,
            "maxPositions": 5,
            "lotSize": 100,
        },
        "exit": {
            "stopLossPct": 3,
            "takeProfitPct": 6,
            "maxHoldingDays": 5,
            "signalExit": None,
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


def thresholds(spec):
    return {
        item["field"]: item["value"]
        for item in spec["entry"]["conditions"]
    }


class StrategyCandidateCatalogTest(unittest.TestCase):
    def test_preregisters_three_distinct_threshold_hypotheses(self):
        source = base_strategy()
        original = copy.deepcopy(source)

        catalog = build_candidate_catalog(source)

        self.assertEqual(source, original)
        self.assertEqual(
            [item["candidateId"] for item in catalog["candidates"]],
            [
                "current-baseline",
                "balanced-confirmation-60",
                "quant-confirmation-65",
            ],
        )
        self.assertEqual(
            thresholds(catalog["candidates"][0]["strategy"]),
            {"marketScore": 55, "quant.score": 55},
        )
        self.assertEqual(
            thresholds(catalog["candidates"][1]["strategy"]),
            {"marketScore": 60, "quant.score": 60},
        )
        self.assertEqual(
            thresholds(catalog["candidates"][2]["strategy"]),
            {"marketScore": 55, "quant.score": 65},
        )
        self.assertEqual(
            len({
                item["strategy"]["specVersion"]
                for item in catalog["candidates"]
            }),
            3,
        )


if __name__ == "__main__":
    unittest.main()
