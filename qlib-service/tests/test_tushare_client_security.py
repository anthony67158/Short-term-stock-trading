import importlib.util
import os
import unittest
import urllib.error
from unittest.mock import Mock, patch


HERE = os.path.dirname(os.path.abspath(__file__))
CLIENT_PATH = os.path.join(HERE, "..", "tushare_client.py")


def load_client():
    spec = importlib.util.spec_from_file_location("tushare_client_security", CLIENT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TushareClientSecurityTest(unittest.TestCase):
    def test_default_url_uses_the_documented_public_https_endpoint(self):
        with patch.dict(os.environ, {}, clear=True):
            client = load_client()

        self.assertEqual(client.DEFAULT_URL, "https://ts.gyzcloud.top/api")

    def test_accepts_only_the_documented_gateway_hosts(self):
        client = load_client()

        self.assertEqual(
            client.validate_gateway_url("https://ts.gyzcloud.top/api"),
            "https://ts.gyzcloud.top/api",
        )
        self.assertEqual(
            client.validate_gateway_url("https://ts2.gyzcloud.top/api"),
            "https://ts2.gyzcloud.top/api",
        )

        for url in (
            "http://ts.gyzcloud.top/api",
            "https://example.com/api",
            "https://ts.gyzcloud.top/other",
            "https://user:pass@ts.gyzcloud.top/api",
            "https://ts.gyzcloud.top/api?token=secret",
        ):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    client.validate_gateway_url(url)

    def test_rejects_rate_limits_above_the_safe_project_cap(self):
        client = load_client()

        with self.assertRaises(ValueError):
            client.TushareClient(
                token="test-only-token",
                max_per_min=136,
            )

    def test_default_rate_keeps_extra_distance_from_the_provider_limit(self):
        client = load_client()

        instance = client.TushareClient(token="test-only-token")

        self.assertEqual(instance._rl.capacity, 90)

    def test_http_429_defers_all_threads_for_the_provider_cooldown(self):
        client = load_client()
        instance = client.TushareClient(token="test-only-token", retries=2)
        instance._rl.acquire = Mock()
        instance._rl.defer = Mock()
        responses = [
            urllib.error.HTTPError(
                instance.url, 429, "Too Many Requests", {}, None
            ),
            ({"code": 0, "data": {"items": [], "fields": []}}, instance.url),
        ]

        def post_once(*_args):
            response = responses.pop(0)
            if isinstance(response, Exception):
                raise response
            return response

        instance._post_once = post_once
        with patch.object(client.time, "sleep"):
            self.assertEqual(instance.call("stock_basic"), ([], []))

        instance._rl.defer.assert_called_once_with(305)

    def test_token_remains_required_outside_source_code(self):
        client = load_client()

        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                client.TushareClient()

    def test_sector_helpers_use_official_tushare_api_names(self):
        client = load_client()
        instance = client.TushareClient(token="test-only-token")
        instance.rows = Mock(return_value=[])

        instance.ths_index(exchange="A", index_type="N")
        instance.ths_daily(ts_code="885001.TI", start_date="20230101")
        instance.moneyflow_ind_ths(trade_date="20260820")

        self.assertEqual(
            [call.args[0] for call in instance.rows.call_args_list],
            ["ths_index", "ths_daily", "moneyflow_ind_ths"],
        )


if __name__ == "__main__":
    unittest.main()
