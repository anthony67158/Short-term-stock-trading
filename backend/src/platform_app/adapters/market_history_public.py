"""Strict readers for observed public daily-bar wire formats."""

from datetime import datetime
from decimal import Decimal

import httpx

from platform_app.adapters.market_tushare import decimal_text

SINA_DAILY_URL = "https://quotes.sina.cn/cn/api/openapi.php/CN_MarketDataService.getKLineData"
TENCENT_DAILY_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
EASTMONEY_DAILY_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
MAX_RESPONSE_BYTES = 2_000_000


class PublicHistoryError(ValueError):
    pass


def _symbol(instrument_id: str) -> str:
    exchange, separator, code = instrument_id.partition(".")
    if (
        separator != "."
        or exchange not in {"SH", "SZ", "BJ"}
        or len(code) != 6
        or not code.isdigit()
    ):
        raise PublicHistoryError("INVALID_PUBLIC_HISTORY_INSTRUMENT")
    return f"{exchange.lower()}{code}"


def _date(value: str) -> str:
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%Y%m%d")
    except ValueError as exc:
        raise PublicHistoryError("INVALID_PUBLIC_HISTORY_DATE") from exc


def _tencent_volume_multiplier(instrument_id: str) -> int:
    return 1 if instrument_id.startswith(("SH.688", "SH.689")) else 100


def _eastmoney_secid(instrument_id: str) -> str:
    exchange, _separator, code = instrument_id.partition(".")
    return f"{1 if exchange == 'SH' else 0}.{code}"


def _bar(
    *,
    trade_date: str,
    opening,
    high,
    low,
    close,
    volume,
    volume_multiplier: int,
) -> dict:
    prices = {
        name: Decimal(decimal_text(value, positive=True))
        for name, value in (
            ("open", opening),
            ("high", high),
            ("low", low),
            ("close", close),
        )
    }
    if prices["high"] < max(prices["open"], prices["close"]) or prices["low"] > min(
        prices["open"], prices["close"]
    ):
        raise PublicHistoryError("INVALID_PUBLIC_HISTORY_OHLC")
    volume_shares = Decimal(decimal_text(volume, nonnegative=True)) * volume_multiplier
    return {
        "tradeDate": _date(trade_date),
        **{name: format(value, "f") for name, value in prices.items()},
        "volumeShares": format(volume_shares, "f"),
    }


def _json(response: httpx.Response) -> dict:
    response.raise_for_status()
    if len(response.content) > MAX_RESPONSE_BYTES:
        raise PublicHistoryError("PUBLIC_HISTORY_RESPONSE_TOO_LARGE")
    try:
        payload = response.json()
    except ValueError as exc:
        raise PublicHistoryError("PUBLIC_HISTORY_RESPONSE_INVALID") from exc
    if not isinstance(payload, dict):
        raise PublicHistoryError("PUBLIC_HISTORY_RESPONSE_INVALID")
    return payload


class SinaDailyClient:
    source = "SINA"

    def __init__(self, *, transport=None, timeout=15):
        self.transport = transport
        self.timeout = timeout

    def bars(self, instrument_id: str, *, limit: int = 1023) -> dict[str, dict]:
        if not 1 <= limit <= 1023:
            raise PublicHistoryError("SINA_HISTORY_LIMIT_INVALID")
        with httpx.Client(
            timeout=httpx.Timeout(self.timeout, connect=min(5, self.timeout)),
            follow_redirects=False,
            transport=self.transport,
        ) as client:
            payload = _json(
                client.get(
                    SINA_DAILY_URL,
                    params={
                        "symbol": _symbol(instrument_id),
                        "scale": "240",
                        "ma": "no",
                        "datalen": str(limit),
                    },
                )
            )
        result = payload.get("result")
        if (
            not isinstance(result, dict)
            or not isinstance(result.get("status"), dict)
            or result["status"].get("code") != 0
            or not isinstance(result.get("data"), list)
        ):
            raise PublicHistoryError("SINA_HISTORY_RESPONSE_INVALID")
        rows = [
            _bar(
                trade_date=str(row.get("day") or ""),
                opening=row.get("open"),
                high=row.get("high"),
                low=row.get("low"),
                close=row.get("close"),
                volume=row.get("volume"),
                volume_multiplier=1,
            )
            for row in result["data"]
            if isinstance(row, dict)
        ]
        if len(rows) != len(result["data"]):
            raise PublicHistoryError("SINA_HISTORY_RESPONSE_INVALID")
        keyed = {row["tradeDate"]: row for row in rows}
        if len(keyed) != len(rows):
            raise PublicHistoryError("SINA_HISTORY_DUPLICATE_DATE")
        return keyed


class TencentDailyClient:
    source = "TENCENT"

    def __init__(self, *, transport=None, timeout=15):
        self.transport = transport
        self.timeout = timeout

    def bars(self, instrument_id: str, start_date: str, end_date: str) -> dict[str, dict]:
        symbol = _symbol(instrument_id)
        start = datetime.strptime(start_date, "%Y%m%d").strftime("%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y%m%d").strftime("%Y-%m-%d")
        with httpx.Client(
            timeout=httpx.Timeout(self.timeout, connect=min(5, self.timeout)),
            follow_redirects=False,
            transport=self.transport,
        ) as client:
            payload = _json(
                client.get(
                    TENCENT_DAILY_URL,
                    params={"param": f"{symbol},day,{start},{end},1023,"},
                )
            )
        data = payload.get("data")
        section = data.get(symbol) if isinstance(data, dict) else None
        rows = section.get("day") if isinstance(section, dict) else None
        if payload.get("code") != 0 or not isinstance(rows, list):
            raise PublicHistoryError("TENCENT_HISTORY_RESPONSE_INVALID")
        normalized = []
        for row in rows:
            if not isinstance(row, list) or len(row) < 6:
                raise PublicHistoryError("TENCENT_HISTORY_RESPONSE_INVALID")
            normalized.append(
                _bar(
                    trade_date=str(row[0]),
                    opening=row[1],
                    close=row[2],
                    high=row[3],
                    low=row[4],
                    volume=row[5],
                    volume_multiplier=_tencent_volume_multiplier(instrument_id),
                )
            )
        keyed = {row["tradeDate"]: row for row in normalized}
        if len(keyed) != len(normalized):
            raise PublicHistoryError("TENCENT_HISTORY_DUPLICATE_DATE")
        return keyed


class EastmoneyDailyClient:
    source = "EASTMONEY"

    def __init__(self, *, transport=None, timeout=15):
        self.transport = transport
        self.timeout = timeout

    def bars(self, instrument_id: str, start_date: str, end_date: str) -> dict[str, dict]:
        _symbol(instrument_id)
        datetime.strptime(start_date, "%Y%m%d")
        datetime.strptime(end_date, "%Y%m%d")
        with httpx.Client(
            timeout=httpx.Timeout(self.timeout, connect=min(5, self.timeout)),
            follow_redirects=False,
            transport=self.transport,
        ) as client:
            payload = _json(
                client.get(
                    EASTMONEY_DAILY_URL,
                    params={
                        "secid": _eastmoney_secid(instrument_id),
                        "klt": "101",
                        "fqt": "0",
                        "beg": start_date,
                        "end": end_date,
                        "fields1": "f1,f2,f3,f4,f5,f6",
                        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
                    },
                )
            )
        data = payload.get("data")
        rows = data.get("klines") if isinstance(data, dict) else None
        if payload.get("rc") != 0 or not isinstance(rows, list):
            raise PublicHistoryError("EASTMONEY_HISTORY_RESPONSE_INVALID")
        normalized = []
        for raw in rows:
            fields = raw.split(",") if isinstance(raw, str) else []
            if len(fields) < 7:
                raise PublicHistoryError("EASTMONEY_HISTORY_RESPONSE_INVALID")
            row = _bar(
                trade_date=fields[0],
                opening=fields[1],
                close=fields[2],
                high=fields[3],
                low=fields[4],
                volume=fields[5],
                volume_multiplier=100,
            )
            row["amountCny"] = decimal_text(fields[6], nonnegative=True)
            normalized.append(row)
        keyed = {row["tradeDate"]: row for row in normalized}
        if len(keyed) != len(normalized):
            raise PublicHistoryError("EASTMONEY_HISTORY_DUPLICATE_DATE")
        return keyed
