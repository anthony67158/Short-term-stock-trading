import os
import sys
import unittest
import datetime as dt
from zoneinfo import ZoneInfo


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from validate_market_archive_report import validate_report  # noqa: E402


class ValidateMarketArchiveReportTest(unittest.TestCase):
    NIGHT_RUN = dt.datetime(
        2026,
        9,
        11,
        1,
        15,
        tzinfo=ZoneInfo("Asia/Shanghai"),
    )

    @staticmethod
    def complete_archive(date):
        return {
            "date": date,
            "summary": {
                "dailyRows": 800,
                "fundRows": 500,
                "minuteCodes": 900,
            },
            "universe": {
                "requestedCodes": 1000,
                "completeCodes": 900,
                "coverage": 0.9,
            },
        }

    def test_schedule_requires_complete_archive(self):
        with self.assertRaisesRegex(
            ValueError,
            "夜间定时训练未获得最新完整市场归档",
        ):
            validate_report({
                "status": "market_open_skipped",
                "date": "20260911",
                "latestArchiveDate": "20260910",
            }, event_name="schedule", now=self.NIGHT_RUN)

    def test_schedule_accepts_published_archive(self):
        result = validate_report({
            "status": "published",
            "date": "20260910",
        }, event_name="schedule", now=self.NIGHT_RUN,
            archive_loader=self.complete_archive)

        self.assertTrue(result["ready"])
        self.assertEqual(result["date"], "20260910")
        self.assertTrue(result["ossVerified"])

    def test_manual_run_may_skip_open_market(self):
        result = validate_report({
            "status": "market_open_skipped",
            "date": "20260911",
            "latestArchiveDate": "20260910",
        }, event_name="workflow_dispatch",
            now=self.NIGHT_RUN,
            archive_loader=self.complete_archive)

        self.assertTrue(result["ready"])
        self.assertEqual(result["mode"], "manual_market_open")
        self.assertEqual(result["date"], "20260910")

    def test_manual_run_rejects_unexplained_reuse(self):
        with self.assertRaisesRegex(
            ValueError,
            "归档端点不可用",
        ):
            validate_report({
                "status": "REUSED_EXISTING_ARCHIVE",
                "reason": "归档端点不可用",
            }, event_name="workflow_dispatch", now=self.NIGHT_RUN)

    def test_complete_status_rejects_unsettled_market_date(self):
        intraday = dt.datetime(
            2026,
            9,
            11,
            11,
            30,
            tzinfo=ZoneInfo("Asia/Shanghai"),
        )
        with self.assertRaisesRegex(
            ValueError,
            "尚未完成收盘结算",
        ):
            validate_report({
                "status": "published",
                "date": "20260911",
            }, event_name="schedule", now=intraday,
                archive_loader=self.complete_archive)

    def test_complete_status_rejects_incomplete_oss_artifact(self):
        with self.assertRaisesRegex(
            ValueError,
            "分钟线覆盖不足",
        ):
            validate_report({
                "status": "already_archived",
                "date": "20260910",
            }, event_name="schedule", now=self.NIGHT_RUN,
                archive_loader=lambda date: {
                "date": date,
                "summary": {
                    "dailyRows": 800,
                    "fundRows": 500,
                    "minuteCodes": 700,
                },
                "universe": {
                    "requestedCodes": 1000,
                    "completeCodes": 700,
                    "coverage": 0.7,
                },
            })

    def test_complete_status_rejects_small_minute_universe(self):
        with self.assertRaisesRegex(
            ValueError,
            "分钟线请求股票池不足",
        ):
            validate_report({
                "status": "already_archived",
                "date": "20260910",
            }, event_name="schedule", now=self.NIGHT_RUN,
                archive_loader=lambda date: {
                    "date": date,
                    "summary": {
                        "dailyRows": 800,
                        "fundRows": 500,
                        "minuteCodes": 90,
                    },
                    "universe": {
                        "requestedCodes": 100,
                        "completeCodes": 90,
                        "coverage": 0.9,
                    },
                })


if __name__ == "__main__":
    unittest.main()
