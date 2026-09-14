import json
import os
import sys
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from stock_mcp_client import (  # noqa: E402
    StockMcpProtocolError,
    StockMcpUpstreamLimitError,
    normalize_stock_minute_result,
    validate_stock_mcp_url,
)


class StockMcpClientTest(unittest.TestCase):
    def test_normalizes_tool_content_to_tushare_compatible_rows(self):
        payload = {
            "result": {
                "isError": False,
                "content": [{
                    "type": "text",
                    "text": json.dumps({
                        "code": 0,
                        "msg": None,
                        "data": {
                            "fields": [
                                "symbol",
                                "trade_time",
                                "open",
                                "close",
                                "high",
                                "low",
                                "vol",
                                "amount",
                            ],
                            "items": [[
                                "600519.SH",
                                "2026-09-11 15:00:00",
                                1500,
                                1501,
                                1502,
                                1499,
                                100,
                                150100,
                            ]],
                        },
                    }),
                }],
            },
        }

        rows = normalize_stock_minute_result(payload, "600519.SH")

        self.assertEqual(rows, [{
            "ts_code": "600519.SH",
            "trade_time": "2026-09-11 15:00:00",
            "open": 1500,
            "close": 1501,
            "high": 1502,
            "low": 1499,
            "vol": 100,
            "amount": 150100,
        }])

    def test_rejects_wrong_symbol_or_missing_fields(self):
        def payload(fields, item):
            return {
                "result": {
                    "content": [{
                        "type": "text",
                        "text": json.dumps({
                            "code": 0,
                            "data": {"fields": fields, "items": [item]},
                        }),
                    }],
                },
            }

        fields = [
            "symbol", "trade_time", "open", "close",
            "high", "low", "vol", "amount",
        ]
        with self.assertRaisesRegex(StockMcpProtocolError, "股票代码"):
            normalize_stock_minute_result(
                payload(fields, [
                    "000001.SZ", "2026-09-11 15:00:00",
                    1, 1, 1, 1, 1, 1,
                ]),
                "600519.SH",
            )
        with self.assertRaisesRegex(StockMcpProtocolError, "字段"):
            normalize_stock_minute_result(
                payload(fields[:-1], [
                    "600519.SH", "2026-09-11 15:00:00",
                    1, 1, 1, 1, 1,
                ]),
                "600519.SH",
            )

    def test_classifies_upstream_ip_limit_without_exposing_raw_message(self):
        payload = {
            "result": {
                "isError": True,
                "content": [{
                    "type": "text",
                    "text": json.dumps({
                        "code": 500,
                        "msg": "ip超限，请不到在多个ip同时使用",
                    }),
                }],
            },
        }

        with self.assertRaisesRegex(
            StockMcpUpstreamLimitError,
            r"IP.*限制",
        ) as raised:
            normalize_stock_minute_result(payload, "600519.SH")

        self.assertNotIn("多个ip", str(raised.exception))

    def test_url_validation_rejects_credential_leak_vectors(self):
        endpoint = validate_stock_mcp_url(
            "https://tx.xiaodefa.top/mcp?token=secret"
        )
        self.assertEqual(endpoint.hostname, "tx.xiaodefa.top")
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            validate_stock_mcp_url(
                "http://tx.xiaodefa.top/mcp?token=secret"
            )
        with self.assertRaisesRegex(ValueError, "主机"):
            validate_stock_mcp_url(
                "https://example.com/mcp?token=secret"
            )
        with self.assertRaisesRegex(ValueError, "token"):
            validate_stock_mcp_url("https://tx.xiaodefa.top/mcp")


if __name__ == "__main__":
    unittest.main()
