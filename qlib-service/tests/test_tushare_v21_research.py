import importlib.util
import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODULE_PATH = os.path.join(HERE, "..", "tushare_v21_research.py")


def load_module():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "tushare_v21_research",
            MODULE_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(SERVICE_ROOT)


class FakeClient:
    def __init__(self, responses=None):
        self.responses = responses or {}
        self.calls = []

    def rows(self, api_name, params=None, fields=""):
        self.calls.append((api_name, params or {}, fields))
        response = self.responses.get(api_name, [])
        if isinstance(response, Exception):
            raise response
        return response


class TushareV21ResearchTest(unittest.TestCase):
    def test_probe_plan_covers_independent_data_without_large_downloads(self):
        module = load_module()

        plan = module.build_probe_plan(
            trade_date="20260811",
            stock_code="600519.SH",
            index_code="000300.SH",
            industry_code="881273.TI",
        )

        self.assertEqual(
            [item["api_name"] for item in plan],
            [
                "stk_mins",
                "stk_mins",
                "rt_idx_min",
                "moneyflow",
                "ths_index",
                "ths_daily",
                "moneyflow_ind_ths",
                "moneyflow_ind_dc",
                "moneyflow_mkt_dc",
                "stk_auction",
                "stk_auction_c",
            ],
        )
        self.assertEqual(plan[0]["params"]["freq"], "5min")
        self.assertEqual(plan[2]["params"]["freq"], "5MIN")
        self.assertTrue(all(item["max_expected_rows"] <= 8000 for item in plan))
        self.assertEqual(
            next(item for item in plan if item["id"] == "stock_moneyflow")[
                "availability"
            ],
            "after_close",
        )

    def test_probe_returns_compact_permission_and_empty_statuses(self):
        module = load_module()
        client = FakeClient({
            "stk_mins": [{"trade_time": "2026-08-11 09:35:00"}],
            "moneyflow": RuntimeError("抱歉，您没有接口访问权限，权限需6000积分"),
        })
        plan = [
            {
                "id": "stock_minutes",
                "api_name": "stk_mins",
                "params": {"ts_code": "600519.SH"},
                "fields": "ts_code,trade_time",
                "availability": "historical",
                "research_use": "pilot",
                "max_expected_rows": 100,
            },
            {
                "id": "stock_moneyflow",
                "api_name": "moneyflow",
                "params": {"ts_code": "600519.SH"},
                "fields": "ts_code,trade_date",
                "availability": "after_close",
                "research_use": "pilot_lagged",
                "max_expected_rows": 100,
            },
            {
                "id": "industry_daily",
                "api_name": "ths_daily",
                "params": {"ts_code": "881273.TI"},
                "fields": "ts_code,trade_date",
                "availability": "after_close",
                "research_use": "pilot_lagged",
                "max_expected_rows": 100,
            },
        ]

        result = module.run_probe_plan(client, plan)

        self.assertEqual(result["stock_minutes"]["status"], "available")
        self.assertEqual(result["stock_minutes"]["rows"], 1)
        self.assertEqual(result["stock_moneyflow"]["status"], "permission_denied")
        self.assertNotIn("error", result["stock_moneyflow"])
        self.assertEqual(result["industry_daily"]["status"], "empty")
        self.assertEqual(len(client.calls), 3)


if __name__ == "__main__":
    unittest.main()
