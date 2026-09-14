import importlib.util
import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
SERVICE_ROOT = os.path.join(ROOT, "qlib-service")
for candidate in (SCRIPTS, SERVICE_ROOT):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

_SPEC = importlib.util.spec_from_file_location(
    "build_alpha158_snapshot",
    os.path.join(SCRIPTS, "build-alpha158-snapshot.py"),
)
snap = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(snap)


class AlphaSnapshotPureFnTest(unittest.TestCase):
    def test_percentile_by_date_ranks_within_each_day(self):
        scores = np.array([1.0, 3.0, 2.0, 10.0, 20.0])
        dates = np.array(["d1", "d1", "d1", "d2", "d2"])
        pct = snap._percentile_by_date(scores, dates)
        # d1: 1→0, 2→0.5, 3→1
        self.assertAlmostEqual(pct[0], 0.0)
        self.assertAlmostEqual(pct[2], 0.5)
        self.assertAlmostEqual(pct[1], 1.0)
        # d2: 10→0, 20→1
        self.assertAlmostEqual(pct[3], 0.0)
        self.assertAlmostEqual(pct[4], 1.0)

    def test_single_stock_day_is_neutral_half(self):
        pct = snap._percentile_by_date(
            np.array([5.0]), np.array(["d1"]),
        )
        self.assertAlmostEqual(pct[0], 0.5)

    def test_momentum_uses_per_code_time_series(self):
        # 同一只股票 6 天，分位从 0 递增到 1；lag=5 → 末日动量 = 1 - 0
        codes = np.array(["600001"] * 6)
        dates = np.array([f"d{i}" for i in range(6)])
        pct = np.array([0.0, 0.2, 0.4, 0.6, 0.8, 1.0])
        mom = snap._momentum_by_code(pct, codes, dates, lag=5)
        self.assertAlmostEqual(mom[5], 1.0)   # 第6天 - 第1天
        self.assertEqual(mom[0], 0.0)         # 无前值
        self.assertEqual(mom[4], 0.0)         # 不足 lag

    def test_momentum_isolated_per_code(self):
        codes = np.array(["A", "B", "A", "B"])
        dates = np.array(["d0", "d0", "d1", "d1"])
        pct = np.array([0.1, 0.9, 0.2, 0.8])
        mom = snap._momentum_by_code(pct, codes, dates, lag=1)
        # A: d1-d0 = 0.2-0.1=0.1 ; B: 0.8-0.9=-0.1
        self.assertAlmostEqual(mom[2], 0.1)
        self.assertAlmostEqual(mom[3], -0.1)

    def test_rolling_rank_ic_perfect_alignment_is_one(self):
        # 每日预测与标签完全同序 → 日度RankIC=1，滚动均值=1
        dates = np.array(sum([[f"d{d}"] * 6 for d in range(5)], []))
        scores = np.tile(np.arange(6, dtype=float), 5)
        labels = np.tile(np.arange(6, dtype=float), 5)  # 同序
        ic = snap._rolling_rank_ic(scores, labels, dates, window=3)
        self.assertTrue(np.allclose(ic, 1.0))

    def test_rolling_rank_ic_reverse_is_minus_one(self):
        dates = np.array(sum([[f"d{d}"] * 6 for d in range(3)], []))
        scores = np.tile(np.arange(6, dtype=float), 3)
        labels = np.tile(np.arange(6, dtype=float)[::-1], 3)  # 反序
        ic = snap._rolling_rank_ic(scores, labels, dates, window=2)
        self.assertTrue(np.allclose(ic, -1.0))

    def test_rolling_rank_ic_small_cross_section_is_zero(self):
        # 每日样本<5 → 日度IC为nan → 全缺回退0
        dates = np.array(["d0", "d0", "d1", "d1"])
        scores = np.array([1.0, 2.0, 3.0, 4.0])
        labels = np.array([1.0, 2.0, 3.0, 4.0])
        ic = snap._rolling_rank_ic(scores, labels, dates, window=5)
        self.assertTrue(np.allclose(ic, 0.0))


if __name__ == "__main__":
    unittest.main()
