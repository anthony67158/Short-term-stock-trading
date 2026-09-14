import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
SERVICE_ROOT = os.path.join(ROOT, "qlib-service")
for candidate in (SCRIPTS, SERVICE_ROOT):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

import importlib.util

_SPEC = importlib.util.spec_from_file_location(
    "backfill_mainboard_history",
    os.path.join(SCRIPTS, "backfill-mainboard-history.py"),
)
backfill = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(backfill)


def daily(code, date, close=10.0, pre_close=9.9, is_st=False):
    return {
        "date": date,
        "code": code,
        "name": "样本",
        "open": close,
        "high": close,
        "low": close,
        "close": close,
        "preClose": pre_close,
        "volume": 100000,
        "amount": 1000000,
        "turnover": 1.0,
        "isSt": is_st,
    }


def fund(code, date, main=1.0, retail=-1.0):
    return {
        "date": date,
        "code": code,
        "mainNetYi": main,
        "retailNetYi": retail,
        "mainRatio": None,
    }


class MainBoardFilterTest(unittest.TestCase):
    def test_is_main_board_excludes_other_boards(self):
        for code in ("000001", "001979", "002415", "003816",
                     "600519", "601318", "603288", "605117"):
            self.assertTrue(backfill.is_main_board(code), code)
        for code in ("300750", "301099", "688981", "689009",
                     "830799", "920819", "43001", "60051"):
            self.assertFalse(backfill.is_main_board(code), code)

    def test_filter_daily_drops_non_mainboard_st_and_bad_price(self):
        rows = [
            daily("600519", "20260101"),
            daily("300750", "20260101"),          # 创业板剔除
            daily("688981", "20260101"),          # 科创板剔除
            daily("600000", "20260101", is_st=True),  # ST 剔除
            daily("601318", "20260101", close=0.0),   # 非法价剔除
            daily("000001", "20260101"),
        ]
        out = backfill.filter_main_board_daily(rows)
        self.assertEqual(
            [r["code"] for r in out],
            ["000001", "600519"],
        )

    def test_filter_daily_dedupes_identical_and_rejects_conflict(self):
        same = [daily("600519", "20260101"), daily("600519", "20260101")]
        self.assertEqual(len(backfill.filter_main_board_daily(same)), 1)
        conflict = [
            daily("600519", "20260101", close=10.0),
            daily("600519", "20260101", close=11.0),
        ]
        with self.assertRaisesRegex(ValueError, "重复冲突"):
            backfill.filter_main_board_daily(conflict)

    def test_coverage_flags_missing_and_unexpected_days(self):
        open_dates = ["20260101", "20260102", "20260105"]
        daily_rows = [
            daily("600519", "20260101"),
            daily("000001", "20260101"),
            daily("600519", "20260102"),
            # 20260105 缺失
            daily("600519", "20260106"),  # 非交易日多余
        ]
        fund_rows = [fund("600519", "20260101")]
        report = backfill.coverage_report(
            daily_rows, fund_rows, open_dates, minimum_coverage=0.99,
        )
        self.assertEqual(report["missingDays"], ["20260105"])
        self.assertEqual(report["unexpectedDays"], ["20260106"])
        self.assertFalse(report["passed"])
        self.assertEqual(report["fundAlignedRows"], 1)

    def test_coverage_passes_when_calendar_fully_aligned(self):
        open_dates = ["20260101", "20260102"]
        daily_rows = [
            daily("600519", "20260101"),
            daily("600519", "20260102"),
            daily("000001", "20260101"),
            daily("000001", "20260102"),
        ]
        fund_rows = [
            fund("600519", "20260101"),
            fund("600519", "20260102"),
            fund("000001", "20260101"),
            fund("000001", "20260102"),
        ]
        report = backfill.coverage_report(
            daily_rows, fund_rows, open_dates, minimum_coverage=0.99,
        )
        self.assertTrue(report["passed"])
        self.assertEqual(report["dateCoverageRatio"], 1.0)
        self.assertEqual(report["fundCoverageRatio"], 1.0)
        self.assertEqual(report["minCodesPerDay"], 2)


if __name__ == "__main__":
    unittest.main()
