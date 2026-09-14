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
                minute_source="mcp",
                workers=4,
                minimum_coverage=0.85,
            ),
            runner.Path("/tmp/v4-retry-test"),
        )

        self.assertEqual(command[command.index("--retries") + 1], "24")
        self.assertEqual(command[command.index("--minute-source") + 1], "mcp")
        self.assertEqual(command[command.index("--workers") + 1], "4")

    def test_resumable_download_restarts_from_persisted_cache(self):
        args = Namespace(
            max_per_min=60,
            retries=6,
            minute_source="mcp",
            workers=4,
            minimum_coverage=0.85,
            download_restarts=0,
            download_retry_delay=2,
            download_retry_max_delay=10,
        )
        with patch.object(
            runner,
            "_run",
            side_effect=[1, 1, 0],
        ) as run, patch.object(
            runner.time,
            "sleep",
        ) as sleep:
            runner._run_resumable_download(
                args,
                runner.Path("/tmp/v4-resume-test"),
            )

        self.assertEqual(run.call_count, 3)
        self.assertEqual(
            [call.args[0] for call in sleep.call_args_list],
            [2, 4],
        )
        self.assertTrue(
            all(call.kwargs["allow_failure"] for call in run.call_args_list)
        )

    def test_resumable_download_honors_finite_restart_budget(self):
        args = Namespace(
            max_per_min=60,
            retries=6,
            minute_source="mcp",
            workers=1,
            minimum_coverage=0.85,
            download_restarts=2,
            download_retry_delay=1,
            download_retry_max_delay=10,
        )
        with patch.object(
            runner,
            "_run",
            return_value=1,
        ), patch.object(
            runner.time,
            "sleep",
        ) as sleep:
            with self.assertRaisesRegex(RuntimeError, "重启次数耗尽"):
                runner._run_resumable_download(
                    args,
                    runner.Path("/tmp/v4-resume-test"),
                )

        sleep.assert_called_once_with(1)

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

    def test_prepare_reuses_complete_existing_plan_without_loading_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            chunk = os.path.join(directory, "chunk-01")
            os.makedirs(chunk)
            for filename in ("daily.json.gz", "funds.json.gz"):
                with open(os.path.join(chunk, filename), "wb") as handle:
                    handle.write(b"cached")
            plan = {
                "schemaVersion": "v4-tushare-backfill-plan.v1",
                "historyDays": 60,
                "signalDaysPerChunk": 145,
                "settlementDays": 7,
                "universeSize": 1000,
                "chunks": [{
                    "index": 1,
                    "from": "20210104",
                    "to": "20211118",
                    "signalFrom": "20210406",
                    "signalTo": "20211109",
                    "signalDays": 145,
                }],
            }
            with open(
                os.path.join(directory, "plan.json"),
                "w",
                encoding="utf-8",
            ) as handle:
                json.dump(plan, handle)
            args = Namespace(
                output=directory,
                history_days=60,
                signal_days=145,
                settlement_days=7,
                universe_size=1000,
                daily="/missing/daily.json.gz",
                funds="/missing/funds.json.gz",
                refresh_plan=False,
            )

            with patch.object(
                runner,
                "_read_gzip",
                side_effect=AssertionError("不应读取源文件"),
            ):
                result = runner._prepare_chunks(args)

        self.assertEqual(result, plan)

    def test_prepare_limits_plan_to_requested_data_range(self):
        dates = [f"2026{index:04d}" for index in range(1, 151)]
        with tempfile.TemporaryDirectory() as directory:
            daily = os.path.join(directory, "daily.json.gz")
            funds = os.path.join(directory, "funds.json.gz")
            runner._write_gzip(
                runner.Path(daily),
                [{"date": date} for date in dates],
            )
            runner._write_gzip(
                runner.Path(funds),
                [{"date": date} for date in dates],
            )
            args = Namespace(
                output=os.path.join(directory, "output"),
                history_days=60,
                signal_days=145,
                settlement_days=7,
                universe_size=1000,
                daily=daily,
                funds=funds,
                refresh_plan=False,
                data_from=dates[20],
                data_to=dates[130],
            )

            plan = runner._prepare_chunks(args)

        self.assertEqual(plan["dataFrom"], dates[20])
        self.assertEqual(plan["dataTo"], dates[130])
        self.assertEqual(plan["chunks"][0]["from"], dates[20])
        self.assertEqual(plan["chunks"][0]["signalFrom"], dates[80])
        self.assertEqual(plan["chunks"][-1]["to"], dates[130])
        self.assertEqual(plan["chunks"][-1]["signalTo"], dates[123])

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

    def test_refresh_v4_rebuilds_cached_chunk_and_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            chunk = os.path.join(directory, "chunk-01")
            os.makedirs(chunk)
            for filename in (
                "opportunity-outcomes-combined.json",
                "opportunity-outcomes-v4.json.gz",
                "audit.json",
            ):
                with open(
                    os.path.join(chunk, filename),
                    "wb",
                ) as handle:
                    handle.write(b"x" * 2048)
            args = Namespace(
                output=directory,
                alpha_snapshot=os.path.join(directory, "alpha.json.gz"),
                refresh_v4=True,
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
