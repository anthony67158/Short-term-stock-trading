import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from factor_research_v2 import analyze_factors


def records():
    output = []
    splits = [
        ("TRAIN", ["20260105", "20260106"]),
        ("CALIBRATION", ["20260205", "20260206"]),
        ("SEALED_TEST", ["20260305", "20260306"]),
    ]
    for split, dates in splits:
        for date_index, date in enumerate(dates):
            for rank in range(10):
                signal = rank + date_index * 0.01
                output.append({
                    "split": split,
                    "date": date,
                    "code": "%06d.SZ" % (rank + 1),
                    "industry": "A" if rank < 5 else "B",
                    "marketCap": 1_000_000_000 + rank * 100_000_000,
                    "adv20": 100_000_000 + rank * 10_000_000,
                    "factors": {
                        "momentum": signal,
                        "momentum_copy": signal * 1.01,
                        "noise": 1 if rank % 2 else -1,
                    },
                    "forwardReturns": {
                        "1": signal / 100,
                        "3": signal / 120,
                        "5": signal / 150,
                    },
                })
    return output


class FactorResearchV2Test(unittest.TestCase):
    def test_reports_ic_rank_ic_neutralization_decay_and_turnover(self):
        report = analyze_factors(
            records(),
            factor_names=["momentum", "momentum_copy", "noise"],
            quantiles=5,
            cost_bps=10,
        )

        self.assertEqual(report["schemaVersion"], "factor-research.v2")
        self.assertEqual(
            report["splitPolicy"]["order"],
            ["TRAIN", "CALIBRATION", "SEALED_TEST"],
        )
        sealed = report["splits"]["SEALED_TEST"]["factors"]["momentum"]
        self.assertGreater(sealed["ic"]["mean"], 0.99)
        self.assertGreater(sealed["rankIc"]["mean"], 0.99)
        self.assertGreater(sealed["quantile"]["longShortReturn"], 0)
        self.assertIn("neutralized", sealed)
        self.assertEqual(
            set(sealed["decay"]),
            {"1", "3", "5"},
        )
        self.assertIn("turnoverRate", sealed)
        self.assertIn("netLongShortReturn", sealed["quantile"])
        self.assertTrue(any(
            pair["left"] == "momentum"
            and pair["right"] == "momentum_copy"
            for pair in report["redundantPairs"]
        ))

    def test_rejects_overlapping_or_out_of_order_research_splits(self):
        overlap = records()
        overlap[-1]["date"] = "20260105"
        with self.assertRaisesRegex(ValueError, "split"):
            analyze_factors(overlap, factor_names=["momentum"])

        out_of_order = records()
        for item in out_of_order:
            if item["split"] == "SEALED_TEST":
                item["date"] = {
                    "20260305": "20260101",
                    "20260306": "20260102",
                }[item["date"]]
        with self.assertRaisesRegex(ValueError, "order"):
            analyze_factors(out_of_order, factor_names=["momentum"])


if __name__ == "__main__":
    unittest.main()
