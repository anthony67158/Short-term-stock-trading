"""Strict Tushare-compatible historical market data transport and normalization."""

import hashlib
import json
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
BLOCK_TRADE_FIELDS = "ts_code,trade_date,price,vol,amount,buyer,seller"
STOCK_BASIC_FIELDS = "ts_code,symbol,name,market,exchange,list_status,list_date,delist_date"
BSE_MAPPING_FIELDS = "name,o_code,n_code,list_date"
TS_CODE = re.compile(r"^(\d{6})\.(SH|SZ|BJ)$")
BSE_CODE_CHANGE_DATE = "20251009"
BSE_OPEN_DATE = "20211115"


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
        exchange == "SH"
        and code.startswith("6")
        or exchange == "SZ"
        and code.startswith(("0", "3"))
        or exchange == "BJ"
        and code.startswith(("4", "8", "920"))
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


def date_text(value, *, optional=False) -> str | None:
    text = str(value or "")
    if optional and not text:
        return None
    try:
        datetime.strptime(text, "%Y%m%d")
    except ValueError as exc:
        raise HistoricalMarketError("INVALID_TRADE_DATE") from exc
    return text


def available_at_text(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise HistoricalMarketError("INVALID_AVAILABLE_AT") from exc
    if parsed.tzinfo is None:
        raise HistoricalMarketError("INVALID_AVAILABLE_AT")
    return value


def normalize_bse_mapping(row: dict, available_at: str) -> dict:
    old_code, old_exchange, _ = instrument_parts(row.get("o_code"))
    new_code, new_exchange, board = instrument_parts(row.get("n_code"))
    if (
        old_exchange != "BJ"
        or new_exchange != "BJ"
        or old_code.startswith("920")
        or not new_code.startswith("920")
    ):
        raise HistoricalMarketError("INVALID_BSE_MAPPING")
    source = {
        "name": str(row.get("name") or "").strip(),
        "o_code": row["o_code"],
        "n_code": row["n_code"],
        "list_date": date_text(row.get("list_date")),
    }
    if not source["name"]:
        raise HistoricalMarketError("INVALID_INSTRUMENT_NAME")
    return {
        "sourceCode": source["o_code"],
        "instrumentId": f"BJ.{new_code}",
        "board": board,
        "effectiveFrom": source["list_date"],
        "effectiveTo": "20251008",
        "reason": "BSE_920_CODE_MIGRATION",
        "source": "TUSHARE_COMPATIBLE",
        "availableAt": available_at_text(available_at),
        "sourceRowSha256": _row_sha256(row),
    }


def normalize_instrument(row: dict, aliases: dict[str, str], available_at: str) -> dict:
    source_code = str(row.get("ts_code") or "").upper()
    canonical_code = aliases.get(source_code, source_code)
    code, exchange, board = instrument_parts(canonical_code)
    status = str(row.get("list_status") or "")
    name = str(row.get("name") or "").strip()
    if status not in {"L", "D", "P"}:
        raise HistoricalMarketError("INVALID_LIST_STATUS")
    if not name:
        raise HistoricalMarketError("INVALID_INSTRUMENT_NAME")
    source = {
        "ts_code": source_code,
        "name": name,
        "list_status": status,
        "list_date": date_text(row.get("list_date")),
        "delist_date": date_text(row.get("delist_date"), optional=True),
    }
    if source["delist_date"] and source["delist_date"] < source["list_date"]:
        raise HistoricalMarketError("INVALID_LISTING_RANGE")
    effective_list_date = (
        max(source["list_date"], BSE_OPEN_DATE) if exchange == "BJ" else source["list_date"]
    )
    return {
        "instrumentId": f"{exchange}.{code}",
        "sourceCode": source_code,
        "exchange": exchange,
        "board": board,
        "name": name,
        "listStatus": status,
        "listDate": effective_list_date,
        "sourceListDate": source["list_date"],
        "delistDate": source["delist_date"],
        "source": "TUSHARE_COMPATIBLE",
        "availableAt": available_at_text(available_at),
        "sourceRowSha256": _row_sha256(row),
    }


def _row_sha256(row: dict) -> str:
    payload = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def canonical_instrument(value: str, aliases: dict[str, str] | None = None) -> tuple[str, str]:
    source_code = str(value or "").upper()
    canonical_code = (aliases or {}).get(source_code, source_code)
    code, exchange, _board = instrument_parts(canonical_code)
    return source_code, f"{exchange}.{code}"


def normalize_daily(row: dict, aliases: dict[str, str] | None = None) -> dict:
    source_code, instrument_id = canonical_instrument(row.get("ts_code"), aliases)
    _code, _exchange, board = instrument_parts((aliases or {}).get(source_code, source_code))
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
        "instrumentId": instrument_id,
        "sourceCode": source_code,
        "tradeDate": date,
        "board": board,
        **{name: format(value, "f") for name, value in prices.items()},
        # Tushare daily uses lots and CNY thousands; canonical units are shares and CNY.
        "volumeShares": scaled_decimal_text(row.get("vol"), 100),
        "amountCny": scaled_decimal_text(row.get("amount"), 1000),
        "adjustment": "RAW",
        "sourceRowSha256": _row_sha256(row),
    }


def normalize_block_trade(row: dict, aliases: dict[str, str] | None = None) -> dict:
    source_code, instrument_id = canonical_instrument(row.get("ts_code"), aliases)
    trade_date = date_text(row.get("trade_date"))
    price = decimal_text(row.get("price"), positive=True)
    volume = Decimal(decimal_text(row.get("vol"), positive=True)) * 10000
    amount = Decimal(decimal_text(row.get("amount"), positive=True)) * 10000
    return {
        "instrumentId": instrument_id,
        "sourceCode": source_code,
        "tradeDate": trade_date,
        "price": price,
        # Tushare block_trade uses 10,000 shares and CNY 10,000.
        "volumeShares": format(volume, "f"),
        "amountCny": format(amount, "f"),
        "sourceRowSha256": _row_sha256(row),
    }


def normalize_minute(
    row: dict,
    expected_instrument: str,
    aliases: dict[str, str] | None = None,
) -> dict:
    source_code, instrument_id = canonical_instrument(row.get("ts_code"), aliases)
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
        "sourceCode": source_code,
        "barEndShanghai": timestamp,
        **{name: format(value, "f") for name, value in prices.items()},
        # Tushare stk_mins already uses shares and CNY.
        "volumeShares": decimal_text(row.get("vol"), nonnegative=True),
        "amountCny": decimal_text(row.get("amount"), nonnegative=True),
        "frequency": "5min",
        "adjustment": "RAW",
        "sourceRowSha256": _row_sha256(row),
    }


def normalize_trade_calendar(row: dict, available_at: str) -> dict:
    exchange = str(row.get("exchange") or "")
    if exchange not in {"SSE", "SZSE"}:
        raise HistoricalMarketError("INVALID_CALENDAR_EXCHANGE")
    is_open = str(row.get("is_open")) if row.get("is_open") is not None else ""
    if is_open not in {"0", "1"}:
        raise HistoricalMarketError("INVALID_CALENDAR_STATE")
    return {
        "exchange": exchange,
        "cal_date": date_text(row.get("cal_date")),
        "is_open": int(is_open),
        "previous_open_date": date_text(row.get("pretrade_date"), optional=True),
        "source": "TUSHARE_COMPATIBLE",
        "available_at": available_at_text(available_at),
        "source_row_sha256": _row_sha256(row),
    }


def normalize_adjustment_factor(
    row: dict,
    aliases: dict[str, str],
    available_at: str,
) -> dict:
    source_code, instrument_id = canonical_instrument(row.get("ts_code"), aliases)
    return {
        "instrument_id": instrument_id,
        "source_code": source_code,
        "trade_date": date_text(row.get("trade_date")),
        "factor": decimal_text(row.get("adj_factor"), positive=True),
        "source": "TUSHARE_COMPATIBLE",
        "available_at": available_at_text(available_at),
        "source_row_sha256": _row_sha256(row),
    }


def normalize_suspension(row: dict, aliases: dict[str, str], available_at: str) -> dict:
    source_code, instrument_id = canonical_instrument(row.get("ts_code"), aliases)
    suspend_type = str(row.get("suspend_type") or "")
    if suspend_type not in {"S", "R"}:
        raise HistoricalMarketError("INVALID_SUSPEND_TYPE")
    return {
        "instrument_id": instrument_id,
        "source_code": source_code,
        "trade_date": date_text(row.get("trade_date")),
        "suspend_type": suspend_type,
        "suspend_timing": str(row.get("suspend_timing") or "ALL_DAY"),
        "source": "TUSHARE_COMPATIBLE",
        "available_at": available_at_text(available_at),
        "source_row_sha256": _row_sha256(row),
    }


def normalize_name_change(row: dict, aliases: dict[str, str], available_at: str) -> dict:
    source_code, instrument_id = canonical_instrument(row.get("ts_code"), aliases)
    name = str(row.get("name") or "").strip()
    if not name:
        raise HistoricalMarketError("INVALID_INSTRUMENT_NAME")
    start_date = date_text(row.get("start_date"))
    end_date = date_text(row.get("end_date"), optional=True)
    if end_date and end_date < start_date:
        raise HistoricalMarketError("INVALID_NAME_RANGE")
    return {
        "instrument_id": instrument_id,
        "source_code": source_code,
        "name": name,
        "start_date": start_date,
        "end_date": end_date,
        "announced_date": date_text(row.get("ann_date"), optional=True),
        "reason": str(row.get("change_reason") or "") or None,
        "source": "TUSHARE_COMPATIBLE",
        "available_at": available_at_text(available_at),
        "source_row_sha256": _row_sha256(row),
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
