import unittest
import weakref
from unittest.mock import patch

from opportunity_pattern_snapshot import publish_strategy_pattern_snapshot
from tests.test_opportunity_pattern_snapshot import FakeBucket, bars


class MinutePayload:
    pass


class PatternSnapshotMemoryTest(unittest.TestCase):
    def test_releases_minutes_before_reading_next_archive(self):
        references = []
        rows = bars()

        def load(_bucket, entry):
            self.assertTrue(all(ref() is None for ref in references))
            minutes = MinutePayload()
            references.append(weakref.ref(minutes))
            row = rows[entry["index"]]
            return {
                "date": row["date"],
                "daily": [{**row, "code": f"{code:06d}"} for code in range(800)],
                "minutes": minutes,
            }

        manifest = {
            "schemaVersion": "opportunity-market-manifest.v1",
            "dates": [{"index": index} for index in range(len(rows))],
        }
        with patch("opportunity_pattern_snapshot._load_market_day_entry", load):
            result = publish_strategy_pattern_snapshot(FakeBucket(), manifest)
        self.assertEqual(result["summary"]["stocks"], 800)
        self.assertEqual(result["summary"]["historyDays"], 61)
        self.assertTrue(all(ref() is None for ref in references))


if __name__ == "__main__":
    unittest.main()
