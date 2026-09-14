import importlib.util
import os
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
_SPEC = importlib.util.spec_from_file_location(
    "run_v4_tushare_backfill",
    os.path.join(ROOT, "scripts", "run_v4_tushare_backfill.py"),
)
runner = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(runner)


class V4TushareBackfillPlanTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
