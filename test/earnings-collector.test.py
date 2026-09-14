import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from tempfile import TemporaryDirectory
from contextlib import redirect_stdout
from io import StringIO

SPEC = importlib.util.spec_from_file_location(
    "earnings_collect", Path(__file__).resolve().parents[1] / "backtest/earnings/collect.py")
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class EarningsCollectorTests(unittest.TestCase):
    def setUp(self):
        self.spec = {"cninfoPageSize": 100, "cninfoMaxPages": 3, "latestObservation": "20260911"}
        self.sample = {"code": "600000.SH", "annDate": "20250711", "period": "20250630"}

    @staticmethod
    def row(identifier):
        return {"secCode": "600000", "orgId": "gssh0600000", "announcementId": identifier}

    def test_caps_page_size_and_checks_all_ids_and_total(self):
        calls = []
        def page(params, _):
            calls.append(params)
            if not params["stock"]:
                return {"totalAnnouncement": 1, "announcements": [self.row("discovery")]}
            index = params["pageNum"]
            return {"totalAnnouncement": 2, "announcements": [self.row(index)]}
        with patch.object(collector, "cninfo_page", side_effect=page):
            result = collector.cninfo_history(self.sample, self.spec, Path("/tmp"))
        self.assertTrue(result["completeWithinScope"])
        self.assertEqual(len(result["rows"]), 2)
        self.assertTrue(all(call["pageSize"] == "30" for call in calls))

    def test_repeated_first_page_fails_instead_of_claiming_complete(self):
        with patch.object(collector, "cninfo_page", return_value={
                "totalAnnouncement": 2, "announcements": [self.row("same")]}):
            with self.assertRaisesRegex(ValueError, "DUPLICATE"):
                collector.cninfo_history(self.sample, self.spec, Path("/tmp"))

    def test_shifting_total_fails_closed(self):
        pages = [
            {"totalAnnouncement": 1, "announcements": [self.row("discovery")]},
            {"totalAnnouncement": 2, "announcements": [self.row("first")]},
            {"totalAnnouncement": 3, "announcements": [self.row("second")]},
        ]
        with patch.object(collector, "cninfo_page", side_effect=pages):
            with self.assertRaisesRegex(ValueError, "UNSTABLE_TOTAL"):
                collector.cninfo_history(self.sample, self.spec, Path("/tmp"))

    def test_sample_selection_is_input_order_invariant_and_has_no_return_field(self):
        spec = json.loads((Path(__file__).resolve().parents[1] / "backtest/earnings/experiment.json").read_text())
        rows = [{"ts_code": f"60000{i}.SH", "ann_date": "20250711", "end_date": "20250630",
                 "net_profit_min": 100 + i} for i in range(5)]
        chosen = collector.choose_samples(rows, spec)
        self.assertEqual(chosen, collector.choose_samples(list(reversed(rows)), spec))
        self.assertTrue(all(set(row) == {"code", "period", "annDate", "sampleKey"} for row in chosen))

    def test_expectation_phase_uses_one_attempt_and_never_runs_source_collection(self):
        config_raw = Path(collector.__file__).with_name("experiment.json").read_bytes()
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "backtest/cache/earnings-v1"
            output.mkdir(parents=True)
            manifest = {"configHash": collector.sha(config_raw), "forecasts": {},
                "sourceAudits": {}, "samples": [self.sample]}
            (output / "manifest.json").write_bytes(collector.encode(manifest))
            calls = []
            class FakeClient:
                def __init__(self, **kwargs):
                    self.kwargs = kwargs
                    calls.append(kwargs)

                def rows(self, api, params, fields):
                    calls.append((api, params))
                    return []
            with patch.object(collector, "ROOT", root), \
                    patch.object(collector, "TushareClient", FakeClient), \
                    patch.object(collector, "cninfo_history", side_effect=AssertionError("WRONG_PHASE")), \
                    patch.object(collector.sys, "argv", ["collect.py", "--phase", "expectations"]), \
                    redirect_stdout(StringIO()):
                collector.main()
            self.assertEqual(calls[0]["retries"], 1)
            self.assertEqual(calls[1][0], "report_rc")
            saved = json.loads((output / "manifest.json").read_bytes())
            self.assertIn("600000.SH:20250630", saved["expectationProbes"])


if __name__ == "__main__":
    unittest.main()
