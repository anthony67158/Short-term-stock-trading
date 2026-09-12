import unittest
from unittest.mock import patch

from archive_public_market_day import fetch_public_minute_day


def tencent_rows(date):
    rows = []
    for index in range(48):
        minute = (
            9 * 60 + 35 + index * 5
            if index < 24
            else 13 * 60 + 5 + (index - 24) * 5
        )
        hour, minute = divmod(minute, 60)
        rows.append([
            f"{date}{hour:02d}{minute:02d}",
            "10", "10.1", "10.2", "9.9", "100", {}, "0.2",
        ])
    return rows


class ArchiveMinuteFallbackTest(unittest.TestCase):
    def load(self, rows):
        calls = []

        def request(url):
            calls.append(url)
            if "eastmoney.com" in url:
                raise OSError("upstream unavailable")
            if not url.startswith("https://ifzq.gtimg.cn/"):
                raise OSError("legacy hostname unavailable")
            return {"data": {"sh600519": {"m5": rows}}}

        with patch("archive_public_market_day._json", side_effect=request):
            result = fetch_public_minute_day("600519", "20260911")
        return result, calls

    def test_current_tencent_host_restores_complete_friday_day(self):
        result, calls = self.load(tencent_rows("20260911"))
        self.assertEqual(len(result), 48)
        self.assertEqual(result[0]["date"], "20260911093500")
        self.assertEqual(result[-1]["date"], "20260911150000")
        self.assertTrue(calls[-1].startswith("https://ifzq.gtimg.cn/"))

    def test_previous_day_must_not_substitute_for_requested_friday(self):
        result, _ = self.load(tencent_rows("20260910"))
        self.assertEqual(result, [])

    def test_incomplete_tencent_day_still_fails_closed(self):
        result, _ = self.load(tencent_rows("20260911")[:30])
        self.assertEqual(result, [])


if __name__ == "__main__":
    unittest.main()
