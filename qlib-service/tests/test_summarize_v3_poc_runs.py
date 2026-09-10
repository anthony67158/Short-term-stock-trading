import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from summarize_v3_poc_runs import summarize_reports  # noqa: E402


def report(
    *,
    data_hash="same",
    utility_mean=0.2,
    utility_lower=0.1,
    ranker_mean=0.2,
    ranker_lower=0.1,
    q10=0.9,
):
    return {
        "schemaVersion": "v3-model-bakeoff.v1",
        "dataset": {"sha256": data_hash},
        "families": {
            "lightgbm": {
                "aggregate": {
                    "utilityTop5MeanNetR": utility_mean,
                    "utilityTop5LowerBound": utility_lower,
                    "rankerTop5MeanNetR": ranker_mean,
                    "rankerTop5LowerBound": ranker_lower,
                    "q10Coverage": q10,
                },
            },
        },
    }


class V3PocSummaryTest(unittest.TestCase):
    def setUp(self):
        self.paths = []

    def tearDown(self):
        for path in self.paths:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass

    def save(self, value):
        import json
        import tempfile

        handle = tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".json",
            delete=False,
            encoding="utf-8",
        )
        json.dump(value, handle)
        handle.close()
        self.paths.append(handle.name)
        return handle.name

    def test_all_seeds_must_pass_lower_bound_and_q10_calibration(self):
        paths = [
            self.save(report()),
            self.save(report(utility_lower=-0.01)),
        ]

        summary = summarize_reports(paths)

        self.assertEqual(
            summary["decision"]["state"],
            "NO_STABLE_WINNER",
        )
        self.assertEqual(
            summary["families"]["lightgbm"][
                "utilityTop5WorstSeedLowerBound"
            ],
            -0.01,
        )
        self.assertFalse(
            summary["families"]["lightgbm"][
                "productionGatePassed"
            ]
        )

    def test_single_family_can_pass_all_stability_gates(self):
        paths = [
            self.save(report()),
            self.save(report(
                utility_mean=0.15,
                utility_lower=0.05,
                q10=0.89,
            )),
        ]

        summary = summarize_reports(paths)

        self.assertEqual(summary["decision"]["state"], "STABLE_WINNER")
        self.assertEqual(summary["decision"]["winner"], "lightgbm")


if __name__ == "__main__":
    unittest.main()
