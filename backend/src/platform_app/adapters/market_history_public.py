"""Strict readers for observed public daily-bar wire formats."""

from datetime import datetime
from decimal import Decimal

import httpx

from platform_app.adapters.market_tushare import decimal_text

SINA_DAILY_URL = (
    "https://quotes.sina.cn/cn/api/openapi.php/CN_MarketDataService.getKLineData"
)
TENCENT_DAILY_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
MAX_RESPONSE_BYTES = 2_000_000


class PublicHistoryError(ValueError):
    pass


def _symbol(instrument_id: str) -> str:
    exchange, separator, code = instrument_id.partition(".")
    if separator != "." or exchange not in {"SH", "SZ", "BJ"} or len(code) != 6 or not code.isdigit():
        raise PublicHistoryError("INVALID_PUBLIC_HISTORY_INSTRUMENT")
    return f"{exchange.lower()}{code}"


def _date(value: str) -> str:
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%Y%m%d")
    except ValueError as exc:
        raise PublicHistoryError("INVALID_PUBLIC_HISTORY_DATE") from exc


def _tencent_volume_multiplier(instrument_id: str) -> int:
    return 1 if instrument_id.startswith(("SH.688", "SH.689")) else 100


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
