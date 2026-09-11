import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, SERVICE_ROOT)

from decision_engine.data.fuyao import (  # noqa: E402
    configured,
    fetch_full_snapshot,
)


def row(index):
    code = f"{index:06d}"
    return {
        "thscode": f"{code}.SZ",
        "ticker": code,
        "last_price": 10.5,
        "price_change": 0.5,
        "price_change_ratio_pct": 5,
        "open_price": 10,
        "high_price": 10.8,
        "low_price": 9.9,
        "prev_price": 10,
        "volume": 1000,
        "turnover": 10_500,
    }


class FuyaoDataTest(unittest.TestCase):
    def test_missing_key_disables_provider_without_request(self):
        self.assertFalse(configured({}))
        self.assertIsNone(fetch_full_snapshot(
            env={},
            fetch_page=lambda _offset: self.fail(
                "未配置Key时不应请求",
            ),
        ))

    def test_complete_snapshot_is_normalized_for_archive(self):
        timestamp = 1_789_056_000_000

        def fetch_page(offset):
            return {
                "timestamp": timestamp,
                "total": 1000,
                "item": [row(index) for index in range(1000)],
            }

        result = fetch_full_snapshot(
            env={"FUYAO_API_KEY": "test-key"},
            fetch_page=fetch_page,
        )

        self.assertEqual(result["total"], 1000)
        self.assertEqual(len(result["rows"]), 1000)
        self.assertEqual(result["source"], "THS_FUYAO")
        self.assertEqual(result["rows"]["000001"]["close"], 10.5)
        self.assertEqual(result["rows"]["000001"]["amount"], 10_500)

    def test_duplicate_or_incomplete_snapshot_fails_closed(self):
        def fetch_page(_offset):
            return {
                "timestamp": 1_789_056_000_000,
                "total": 1000,
                "item": [row(1) for _ in range(1000)],
            }

        with self.assertRaisesRegex(ValueError, "快照不完整"):
            fetch_full_snapshot(
                env={"FUYAO_API_KEY": "test-key"},
                fetch_page=fetch_page,
            )


if __name__ == "__main__":
    unittest.main()
