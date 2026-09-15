"""Strict Tushare-compatible historical market data transport and normalization."""

import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from urllib.parse import urljoin, urlsplit

import httpx

from platform_app.config import settings

ALLOWED_ENDPOINTS = {
    ("api.tushare.pro", ""),
    ("ts.gyzcloud.top", "/api"),
    ("ts2.gyzcloud.top", "/api"),
    ("tx.xiaodefa.top", "/"),
}
DAILY_FIELDS = "ts_code,trade_date,open,high,low,close,pre_close,vol,amount"
MINUTE_FIELDS = "ts_code,trade_time,open,close,high,low,vol,amount"
TS_CODE = re.compile(r"^(\d{6})\.(SH|SZ|BJ)$")


class HistoricalMarketError(ValueError):
    pass


def validate_endpoint(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or (parsed.hostname, parsed.path) not in ALLOWED_ENDPOINTS
        or parsed.port not in (None, 443)
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise HistoricalMarketError("MARKET_DATA_ENDPOINT_REJECTED")
    return value


def instrument_parts(value: str) -> tuple[str, str, str]:
    match = TS_CODE.fullmatch(str(value).upper())
    if not match:
        raise HistoricalMarketError("INVALID_INSTRUMENT")
    code, exchange = match.groups()
    valid = (
        exchange == "SH" and code.startswith("6")
        or exchange == "SZ" and code.startswith(("0", "3"))
        or exchange == "BJ" and code.startswith(("4", "8", "920"))
    )
    if not valid:
        raise HistoricalMarketError("INVALID_INSTRUMENT_MARKET")
    board = (
        "BEIJING"
        if exchange == "BJ"
        else "STAR"
        if exchange == "SH" and code.startswith(("688", "689"))
        else "CHINEXT"
        if exchange == "SZ" and code.startswith(("300", "301", "302"))
        else "MAIN"
    )
    return code, exchange, board


def decimal_text(value, *, positive=False, nonnegative=False) -> str:
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise HistoricalMarketError("INVALID_MARKET_NUMBER") from exc
    if not number.is_finite() or positive and number <= 0 or nonnegative and number < 0:
        raise HistoricalMarketError("INVALID_MARKET_NUMBER")
    return format(number, "f")


def scaled_decimal_text(value, multiplier: int) -> str:
    return decimal_text(Decimal(decimal_text(value, nonnegative=True)) * multiplier)


def normalize_daily(row: dict) -> dict:
    code, exchange, board = instrument_parts(row.get("ts_code"))
    date = str(row.get("trade_date") or "")
    if not re.fullmatch(r"\d{8}", date):
        raise HistoricalMarketError("INVALID_TRADE_DATE")
    prices = {
        name: Decimal(decimal_text(row.get(source), positive=True))
        for name, source in (
            ("open", "open"),
            ("high", "high"),
            ("low", "low"),
            ("close", "close"),
            ("previousClose", "pre_close"),
        )
    }
    if prices["high"] < max(prices["open"], prices["close"]) or prices["low"] > min(
        prices["open"], prices["close"]
    ):
        raise HistoricalMarketError("INVALID_OHLC")
    return {
        "instrumentId": f"{exchange}.{code}",
        "tradeDate": date,
        "board": board,
        **{name: format(value, "f") for name, value in prices.items()},
        # Tushare daily uses lots and CNY thousands; canonical units are shares and CNY.
        "volumeShares": scaled_decimal_text(row.get("vol"), 100),
        "amountCny": scaled_decimal_text(row.get("amount"), 1000),
        "adjustment": "RAW",
    }


def normalize_minute(row: dict, expected_instrument: str) -> dict:
    code, exchange, _board = instrument_parts(row.get("ts_code"))
    instrument_id = f"{exchange}.{code}"
    if instrument_id != expected_instrument:
        raise HistoricalMarketError("MINUTE_INSTRUMENT_MISMATCH")
    timestamp = str(row.get("trade_time") or "")
    try:
        datetime.strptime(timestamp, "%Y-%m-%d %H:%M:%S")
    except ValueError as exc:
        raise HistoricalMarketError("INVALID_MINUTE_TIME") from exc
    prices = {
        name: Decimal(decimal_text(row.get(source), positive=True))
        for name, source in (
            ("open", "open"),
            ("high", "high"),
            ("low", "low"),
            ("close", "close"),
        )
    }
    if prices["high"] < max(prices["open"], prices["close"]) or prices["low"] > min(
        prices["open"], prices["close"]
    ):
        raise HistoricalMarketError("INVALID_OHLC")
    return {
        "instrumentId": instrument_id,
        "barEndShanghai": timestamp,
        **{name: format(value, "f") for name, value in prices.items()},
        # Tushare stk_mins already uses shares and CNY.
        "volumeShares": decimal_text(row.get("vol"), nonnegative=True),
        "amountCny": decimal_text(row.get("amount"), nonnegative=True),
        "frequency": "5min",
        "adjustment": "RAW",
    }


class TushareClient:
    def __init__(self, *, transport=None):
        config = settings()
        if not config.market_data_enabled or not config.market_data_api_key.get_secret_value():
            raise HistoricalMarketError("MARKET_DATA_UNAVAILABLE")
        self.endpoint = validate_endpoint(config.market_data_base_url)
        self.api_key = config.market_data_api_key.get_secret_value()
        self.timeout = config.market_data_timeout_seconds
        self.transport = transport

    def rows(self, api_name: str, params: dict, fields: str) -> list[dict]:
        endpoint = self.endpoint
        body = {
            "api_name": api_name,
            "token": self.api_key,
            "params": params,
            "fields": fields,
        }
        with httpx.Client(
            timeout=httpx.Timeout(self.timeout, connect=min(5, self.timeout)),
            follow_redirects=False,
            transport=self.transport,
        ) as client:
            for _ in range(3):
                response = client.post(endpoint, json=body)
                if response.status_code in (301, 302, 307, 308):
                    location = response.headers.get("location")
                    if not location:
                        raise HistoricalMarketError("MARKET_DATA_REDIRECT_INVALID")
                    endpoint = validate_endpoint(urljoin(endpoint, location))
                    continue
                if response.status_code in (401, 403):
                    raise HistoricalMarketError("MARKET_DATA_AUTH_FAILED")
                if response.status_code == 429:
                    raise HistoricalMarketError("MARKET_DATA_RATE_LIMITED")
                try:
                    response.raise_for_status()
                    payload = response.json()
                except (httpx.HTTPError, ValueError) as exc:
                    raise HistoricalMarketError("MARKET_DATA_UPSTREAM_FAILED") from exc
                if not isinstance(payload, dict):
                    raise HistoricalMarketError("MARKET_DATA_RESPONSE_INVALID")
                if payload.get("code") != 0:
                    raise HistoricalMarketError("MARKET_DATA_API_FAILED")
                data = payload.get("data") or {}
                columns, items = data.get("fields"), data.get("items")
                if not isinstance(columns, list) or not isinstance(items, list):
                    raise HistoricalMarketError("MARKET_DATA_RESPONSE_INVALID")
                if any(not isinstance(item, list) or len(item) != len(columns) for item in items):
                    raise HistoricalMarketError("MARKET_DATA_RESPONSE_INVALID")
                return [dict(zip(columns, item, strict=True)) for item in items]
        raise HistoricalMarketError("MARKET_DATA_REDIRECT_LIMIT")
