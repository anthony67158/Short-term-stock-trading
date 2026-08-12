import importlib.util
import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
MODULE_PATH = os.path.join(
    SERVICE_ROOT,
    "collect_tushare_v21_pilot.py",
)


def load_module():
    sys.path.insert(0, SERVICE_ROOT)
    try:
        spec = importlib.util.spec_from_file_location(
            "collect_tushare_v21_pilot",
            MODULE_PATH,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(SERVICE_ROOT)


class FakeClient:
    def __init__(self):
        self.calls = []

    def rows(self, api_name, params=None, fields=""):
        self.calls.append((api_name, params or {}, fields))
        trade_date = (params or {}).get("start_date", "20260808")
        if api_name == "moneyflow_mkt_dc":
            return [{"trade_date": "20260808", "net_amount_rate": 1.0}]
        return [{"trade_date": trade_date, "ts_code": params.get("ts_code")}]


class CollectTushareV21PilotTest(unittest.TestCase):
    def test_collection_is_bounded_to_three_stock_calls_and_one_market_call(self):
        module = load_module()
        client = FakeClient()

        result = module.collect_pilot_cache(
            client,
            ["600519.SH", "000001.SZ"],
            start_date="20260701",
            end_date="20260811",
        )

        counts = {}
        for api_name, _params, _fields in client.calls:
            counts[api_name] = counts.get(api_name, 0) + 1
        self.assertEqual(counts, {
            "moneyflow_mkt_dc": 1,
            "daily_basic": 2,
            "moneyflow": 2,
            "stk_auction": 2,
        })
        self.assertEqual(sorted(result["stocks"]), ["000001.SZ", "600519.SH"])
        self.assertEqual(result["meta"]["codes"], 2)
        self.assertEqual(result["meta"]["calls"], 7)
        for _api_name, params, _fields in client.calls:
            self.assertEqual(params.get("start_date"), "20260701")
            self.assertEqual(params.get("end_date"), "20260811")

    def test_collection_keeps_permission_failures_per_source(self):
        module = load_module()

        class PartialClient(FakeClient):
            def rows(self, api_name, params=None, fields=""):
                if api_name == "stk_auction":
                    raise RuntimeError("没有接口访问权限")
                return super().rows(api_name, params, fields)

        result = module.collect_pilot_cache(
            PartialClient(),
            ["600519.SH"],
            start_date="20260701",
            end_date="20260811",
        )

        self.assertEqual(result["stocks"]["600519.SH"]["auction"], [])
        self.assertEqual(
            result["meta"]["failures"]["600519.SH.stk_auction"],
            "permission_denied",
        )


if __name__ == "__main__":
    unittest.main()
