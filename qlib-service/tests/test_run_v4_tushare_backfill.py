import importlib.util
import gzip
import json
import os
import tempfile
import unittest
from argparse import Namespace
from unittest.mock import patch


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
_SPEC = importlib.util.spec_from_file_location(
    "run_v4_tushare_backfill",
    os.path.join(ROOT, "scripts", "run_v4_tushare_backfill.py"),
)
runner = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(runner)


class V4TushareBackfillPlanTest(unittest.TestCase):
    def test_download_command_forwards_retry_budget(self):
        command = runner._download_command(
            Namespace(
                max_per_min=90,
                retries=24,
                minimum_coverage=0.85,
            ),
            runner.Path("/tmp/v4-retry-test"),
        )

        self.assertEqual(command[command.index("--retries") + 1], "24")

    def test_plan_covers_every_eligible_signal_date_once(self):
        dates = [f"2026{i:04d}" for i in range(1, 251)]
        chunks = runner.build_chunk_plan(
            dates,
            history_days=20,
            signal_days=50,
            settlement_days=5,
        )

        signals = []
        for chunk in chunks:
            start = dates.index(chunk["signalFrom"])
            end = dates.index(chunk["signalTo"])
            signals.extend(dates[start:end + 1])
            self.assertEqual(
                chunk["from"],
                dates[start - 20],
            )
            self.assertEqual(
                chunk["to"],
                dates[end + 5],
            )
            self.assertLessEqual(chunk["signalDays"] + 5, 160)

        self.assertEqual(signals, dates[20:-5])
        self.assertEqual(len(signals), len(set(signals)))

    def test_final_chunk_can_be_shorter(self):
        dates = [f"2026{i:04d}" for i in range(1, 104)]
        chunks = runner.build_chunk_plan(
            dates,
            history_days=10,
            signal_days=40,
            settlement_days=3,
            minimum_signal_days=10,
        )

        self.assertEqual([row["signalDays"] for row in chunks], [40, 40, 10])

    def test_tiny_tail_is_rebalanced_into_two_valid_chunks(self):
        dates = [f"2026{i:04d}" for i in range(1, 239)]
        chunks = runner.build_chunk_plan(
            dates,
            history_days=20,
            signal_days=100,
            settlement_days=5,
            minimum_signal_days=60,
        )

        self.assertEqual([row["signalDays"] for row in chunks], [100, 113])
        signals = []
        for chunk in chunks:
            start = dates.index(chunk["signalFrom"])
            end = dates.index(chunk["signalTo"])
            signals.extend(dates[start:end + 1])
        self.assertEqual(signals, dates[20:-5])

    def test_cached_replay_still_builds_missing_v4_chunk(self):
        with tempfile.TemporaryDirectory() as directory:
            chunk = os.path.join(directory, "chunk-01")
            os.makedirs(chunk)
            with open(
                os.path.join(chunk, "opportunity-outcomes-combined.json"),
                "w",
                encoding="utf-8",
            ) as handle:
                handle.write("x" * 2048)
            args = Namespace(
                output=directory,
                alpha_snapshot=os.path.join(directory, "alpha.json.gz"),
            )
            with patch.object(
                runner,
                "_build_v4_chunk",
            ) as build, patch.object(
                runner,
                "_write_chunk_audit",
            ) as audit:
                runner._run_chunk(args, {"index": 1})

            build.assert_called_once()
            audit.assert_called_once()

    def test_merge_uses_v4_chunk_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            for index in (1, 2):
                chunk = os.path.join(directory, f"chunk-{index:02d}")
                os.makedirs(chunk)
                value = {
                    "outcomes": [{
                        "decisionId": f"formula:{index}",
                        "code": "600001",
                        "tradeDate": f"20260{index}01",
                        "maturity": "MATURED",
                        "fillStatus": "TRIGGERED_UNFILLED",
                        "reviewScoreInput": {
                            "schemaVersion": runner.V4_FEATURE_SCHEMA,
                            "asOf": index,
                            "factors": {
                                name: float(index)
                                for name in runner.V4_FEATURE_NAMES
                            },
                            "priceContract": {"hash": f"hash-{index}"},
                        },
                        "context": {
                            "source": "HISTORICAL",
                            "sectorPhase": "STARTUP",
                            "unused": "must-not-enter-training-merge",
                        },
                        "scoreInput": {"unused": True},
                        "observations": [{"unused": True}],
                    }],
                }
                with gzip.open(
                    os.path.join(chunk, "opportunity-outcomes-v4.json.gz"),
                    "wt",
                    encoding="utf-8",
                ) as handle:
                    json.dump(value, handle)
            plan = {
                "chunks": [
                    {
                        "index": 1,
                        "signalFrom": "20260101",
                        "signalTo": "20260131",
                    },
                    {
                        "index": 2,
                        "signalFrom": "20260201",
                        "signalTo": "20260228",
                    },
                ],
            }
            runner._merge_chunks(Namespace(output=directory), plan)
            with gzip.open(
                os.path.join(directory, "opportunity-outcomes-v4-5y.json.gz"),
                "rt",
                encoding="utf-8",
            ) as handle:
                merged = json.load(handle)

            self.assertEqual(
                [item["decisionId"] for item in merged["outcomes"]],
                ["formula:1", "formula:2"],
            )
            self.assertEqual(
                merged["outcomes"][0]["reviewScoreInput"]["factorValues"],
                [1.0] * len(runner.V4_FEATURE_NAMES),
            )
            self.assertNotIn(
                "factors",
                merged["outcomes"][0]["reviewScoreInput"],
            )
            self.assertEqual(
                merged["outcomes"][0]["context"],
                {
                    "source": "HISTORICAL",
                    "sectorPhase": "STARTUP",
                },
            )
            self.assertNotIn("scoreInput", merged["outcomes"][0])
            self.assertNotIn("observations", merged["outcomes"][0])


if __name__ == "__main__":
    unittest.main()
