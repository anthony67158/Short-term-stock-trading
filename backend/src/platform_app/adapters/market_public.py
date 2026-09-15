"""Observed public wire formats, not a licensed historical/real-time feed.

Timeouts: https://www.python-httpx.org/advanced/timeouts/
Fail closed on layout changes; do not infer availability from download time.
"""
import json
import re
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo

import httpx

from platform_app.contracts.base import utcnow
from platform_app.modules.market.contracts import QuoteView

SINA = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
TENCENT = "https://qt.gtimg.cn/"


class MarketError(ValueError):
    def __init__(self, code="MARKET_UNAVAILABLE", message="行情源暂不可用，请稍后重试", status=503):
        self.code, self.message, self.status = code, message, status


def get_json(client: httpx.Client, method: str, params: dict):
    response = client.get(SINA + method, params=params)
    response.raise_for_status()
    return response.json()


def download_universe() -> list[dict]:
    try:
        # Sequential pages respect the public endpoint; a hard page ceiling limits work.
        with httpx.Client(timeout=httpx.Timeout(10, connect=5), follow_redirects=False) as client:
            count = int(get_json(client, "Market_Center.getHQNodeStockCount", {"node": "hs_a"}))
            if not 1000 <= count <= 20000:
                raise ValueError("invalid universe count")
            rows = []
            page_size = 100
            for page in range(1, (count + page_size - 1) // page_size + 1):
                part = get_json(client, "Market_Center.getHQNodeData", {
                    "page": page, "num": page_size, "sort": "symbol",
                    "asc": 1, "node": "hs_a", "symbol": "",
                })
                expected = min(page_size, count - len(rows))
                if not isinstance(part, list) or len(part) != expected:
                    raise ValueError("incomplete page")
                rows.extend(part)
            end_count = int(get_json(
                client, "Market_Center.getHQNodeStockCount", {"node": "hs_a"},
            ))
            normalized = normalize_universe(rows, count)
            if count != end_count:
                raise ValueError("universe changed during acquisition")
            return normalized
    except (httpx.HTTPError, ValueError, TypeError, KeyError) as exc:
        raise MarketError("UNIVERSE_INCOMPLETE", "证券目录下载不完整，未更新当前目录") from exc


def normalize_universe(rows: list[dict], expected_count: int) -> list[dict]:
    result = []
    for row in rows:
        symbol, code, name = row["symbol"], row["code"], row["name"]
        if not re.fullmatch(r"(sh|sz|bj)\d{6}", symbol) or symbol[2:] != code:
            raise ValueError("invalid security identity")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
            raise ValueError("invalid security name")
        exchange = symbol[:2].upper()
        board = ("BEIJING" if exchange == "BJ" else
                 "STAR" if exchange == "SH" and code.startswith("688") else
                 "CHINEXT" if exchange == "SZ" and code.startswith(("300", "301")) else
                 "MAIN" if (exchange == "SH" and code.startswith(("600", "601", "603", "605"))
                            or exchange == "SZ" and code.startswith(("000", "001", "002", "003")))
                 else "UNKNOWN")
        result.append({
            "id": f"{exchange}.{code}", "code": code, "exchange": exchange,
            "name": name.strip(), "board": board,
        })
    keys = [row["id"] for row in result]
    if len(keys) != expected_count or len(set(keys)) != expected_count or keys != sorted(keys):
        raise ValueError("missing, duplicate or unordered universe")
    return result


def parse_quote(raw: str, instrument_id: str, received_at=None) -> QuoteView:
    received_at = received_at or utcnow()
    symbol = instrument_id.replace(".", "").lower()
    match = re.fullmatch(rf'v_{re.escape(symbol)}="([^"]*)";\s*', raw)
    if not match:
        raise ValueError("unexpected quote payload")
    fields = match.group(1).split("~")
    if len(fields) < 35 or fields[2] != instrument_id.split(".")[1] or not fields[1]:
        raise ValueError("quote identity mismatch")
    quoted_at = datetime.strptime(fields[30], "%Y%m%d%H%M%S").replace(
        tzinfo=ZoneInfo("Asia/Shanghai"),
    )
    age = received_at - quoted_at
    if age < -timedelta(seconds=30):
        raise ValueError("future quote")

    def positive(index):
        try:
            value = Decimal(fields[index]) if fields[index] else None
        except InvalidOperation as exc:
            raise ValueError("invalid quote number") from exc
        if value is not None and (not value.is_finite() or value < 0):
            raise ValueError("invalid quote number")
        return value if value else None

    price, previous = positive(3), positive(4)
    return QuoteView(
        instrument_id=instrument_id, name=fields[1], price=price, previous_close=previous,
        open=positive(5), high=positive(33), low=positive(34),
        change_ratio=(price - previous) / previous if price and previous else None,
        quoted_at=quoted_at, received_at=received_at, source_url=TENCENT + "q=" + symbol,
        freshness="RECENT" if age <= timedelta(seconds=120) else "STALE",
        missing_reason=None if price else "行情源未提供有效成交价",
    )


def fetch_quote(instrument_id: str) -> QuoteView:
    symbol = instrument_id.replace(".", "").lower()
    try:
        with httpx.Client(timeout=httpx.Timeout(8, connect=4)) as client:
            response = client.get(TENCENT, params={"q": symbol})
            response.raise_for_status()
            return parse_quote(response.content.decode("gb18030"), instrument_id)
    except (httpx.HTTPError, ValueError, IndexError) as exc:
        raise MarketError() from exc


def canonical(rows: list[dict]) -> str:
    return json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
