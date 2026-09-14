"""Minimal, read-only Streamable HTTP MCP client for stock minute bars."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request


ALLOWED_HOSTS = frozenset({"tx.xiaodefa.top"})
REQUIRED_MINUTE_FIELDS = (
    "symbol",
    "trade_time",
    "open",
    "close",
    "high",
    "low",
    "vol",
    "amount",
)


class StockMcpProtocolError(RuntimeError):
    pass


class StockMcpUpstreamLimitError(StockMcpProtocolError):
    pass


def validate_stock_mcp_url(value):
    endpoint = urllib.parse.urlsplit(str(value or "").strip())
    if endpoint.scheme != "https":
        raise ValueError("STOCK_MCP_URL 必须使用 HTTPS")
    if endpoint.hostname not in ALLOWED_HOSTS:
        raise ValueError("STOCK_MCP_URL 主机不在允许列表")
    if endpoint.username or endpoint.password or endpoint.fragment:
        raise ValueError("STOCK_MCP_URL 不得包含用户信息或片段")
    if endpoint.port not in (None, 443) or endpoint.path != "/mcp":
        raise ValueError("STOCK_MCP_URL 端口或路径无效")
    query = urllib.parse.parse_qs(
        endpoint.query,
        keep_blank_values=True,
        strict_parsing=True,
    )
    if set(query) != {"token"} or len(query["token"]) != 1 or not query["token"][0]:
        raise ValueError("STOCK_MCP_URL 必须且只能包含非空 token")
    return endpoint


def _jsonrpc_from_body(body):
    text = body.decode("utf-8")
    candidates = [
        line[6:]
        for line in text.splitlines()
        if line.startswith("data: ")
    ]
    if not candidates and text.strip():
        candidates = [text]
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise StockMcpProtocolError("MCP 响应不是有效 JSON-RPC")


def normalize_stock_minute_result(payload, expected_symbol):
    if not isinstance(payload, dict) or payload.get("error"):
        raise StockMcpProtocolError("MCP 工具调用失败")
    result = payload.get("result")
    if not isinstance(result, dict):
        raise StockMcpProtocolError("MCP 分钟工具返回错误")
    content = result.get("content")
    text = next(
        (
            item.get("text")
            for item in content or []
            if isinstance(item, dict)
            and item.get("type") == "text"
            and isinstance(item.get("text"), str)
        ),
        None,
    )
    if text is None:
        raise StockMcpProtocolError("MCP 分钟工具缺少文本结果")
    try:
        tool_result = json.loads(text)
    except json.JSONDecodeError as exc:
        raise StockMcpProtocolError("MCP 分钟工具结果不是有效 JSON") from exc
    if not isinstance(tool_result, dict):
        raise StockMcpProtocolError("MCP 分钟工具结果结构无效")
    if result.get("isError"):
        message = str(tool_result.get("msg") or "")
        if "ip超限" in message:
            raise StockMcpUpstreamLimitError("MCP 上游 IP 限制")
        raise StockMcpProtocolError("MCP 分钟工具返回错误")
    if tool_result.get("code") != 0:
        raise StockMcpProtocolError("MCP 分钟工具业务调用失败")
    data = tool_result.get("data")
    fields = data.get("fields") if isinstance(data, dict) else None
    items = data.get("items") if isinstance(data, dict) else None
    if (
        not isinstance(fields, list)
        or not set(REQUIRED_MINUTE_FIELDS).issubset(fields)
        or not isinstance(items, list)
    ):
        raise StockMcpProtocolError("MCP 分钟工具字段结构无效")
    indexes = {field: fields.index(field) for field in REQUIRED_MINUTE_FIELDS}
    rows = []
    for item in items:
        if not isinstance(item, list) or len(item) != len(fields):
            raise StockMcpProtocolError("MCP 分钟工具数据行结构无效")
        symbol = str(item[indexes["symbol"]] or "").upper()
        if symbol != expected_symbol:
            raise StockMcpProtocolError("MCP 分钟工具股票代码与请求不一致")
        rows.append({
            "ts_code": symbol,
            "trade_time": item[indexes["trade_time"]],
            "open": item[indexes["open"]],
            "close": item[indexes["close"]],
            "high": item[indexes["high"]],
            "low": item[indexes["low"]],
            "vol": item[indexes["vol"]],
            "amount": item[indexes["amount"]],
        })
    return rows


class StockMcpClient:
    def __init__(self, endpoint=None, timeout=90):
        raw_endpoint = endpoint or os.environ.get("STOCK_MCP_URL", "")
        validate_stock_mcp_url(raw_endpoint)
        self._endpoint = raw_endpoint
        self._timeout = timeout
        self._session_id = None
        self._request_id = 0
        self._initialize()

    def _request(self, method, params=None, *, notification=False):
        self._request_id += 1
        payload = {
            "jsonrpc": "2.0",
            "method": method,
        }
        if not notification:
            payload["id"] = self._request_id
        if params is not None:
            payload["params"] = params
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        request = urllib.request.Request(
            self._endpoint,
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                if self._session_id is None:
                    self._session_id = response.headers.get("Mcp-Session-Id")
                body = response.read()
        except (urllib.error.URLError, TimeoutError) as exc:
            raise StockMcpProtocolError("MCP 请求失败") from exc
        if notification:
            return None
        return _jsonrpc_from_body(body)

    def _initialize(self):
        response = self._request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "stock-dashboard-backfill",
                "version": "1.0.0",
            },
        })
        result = response.get("result") if isinstance(response, dict) else None
        if not isinstance(result, dict) or not self._session_id:
            raise StockMcpProtocolError("MCP 初始化失败")
        self._request("notifications/initialized", notification=True)

    def stock_minutes(self, symbol, start_date, end_date):
        payload = self._request("tools/call", {
            "name": "stk_mins",
            "arguments": {
                "symbol": symbol,
                "freq": "5min",
                "start_date": start_date,
                "end_date": end_date,
            },
        })
        return normalize_stock_minute_result(payload, symbol)
