"""Same-source Fuyao market-data adapter for training archives."""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import json
import math
import os
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo


BASE_URL = "https://fuyao.aicubes.cn"
PAGE_SIZE = 1000
MAX_PAGES = 10
SOURCE = "THS_FUYAO"
ZONE = ZoneInfo("Asia/Shanghai")


def configured(env=None):
    source = os.environ if env is None else env
    return bool(str(source.get("FUYAO_API_KEY") or "").strip())


def _number(value):
    if value in (None, "", "-") or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _trade_date(timestamp):
    value = _number(timestamp)
    if value is None or value <= 0:
        return None
    return dt.datetime.fromtimestamp(
        value / 1000,
        tz=ZONE,
    ).strftime("%Y%m%d")


def request_json(path, query, *, env=None, timeout=12):
    source = os.environ if env is None else env
    key = str(source.get("FUYAO_API_KEY") or "").strip()
    if not key:
        return None
    url = (
        BASE_URL
        + path
        + "?"
        + urllib.parse.urlencode(query)
    )
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "X-api-key": key,
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if int(payload.get("code", -1)) != 0:
        raise RuntimeError(
            f"扶摇行情业务错误 {payload.get('code', 'UNKNOWN')}"
        )
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("item"), list):
        raise ValueError("扶摇行情响应结构无效")
    return data


def fetch_snapshot_page(
    offset,
    *,
    page_size=PAGE_SIZE,
    env=None,
    request=request_json,
):
    return request(
        "/api/a-share/prices/snapshot",
        {
            "limit": int(page_size),
            "offset": int(offset),
        },
        env=env,
    )


def fetch_full_snapshot(
    *,
    env=None,
    workers=6,
    fetch_page=None,
):
    if not configured(env):
        return None
    load_page = fetch_page or (
        lambda offset: fetch_snapshot_page(offset, env=env)
    )
    first = load_page(0)
    total = int((first or {}).get("total") or 0)
    if total < 800:
        raise ValueError("扶摇全市场股票总数异常")
    page_count = math.ceil(total / PAGE_SIZE)
    if not 1 <= page_count <= MAX_PAGES:
        raise ValueError("扶摇全市场分页数异常")
    pages = {0: first}
    offsets = [
        index * PAGE_SIZE
        for index in range(1, page_count)
    ]
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=max(1, min(int(workers), 12)),
    ) as executor:
        futures = {
            executor.submit(load_page, offset): offset
            for offset in offsets
        }
        for future in concurrent.futures.as_completed(futures):
            pages[futures[future]] = future.result()
    rows = []
    timestamps = []
    for offset in [index * PAGE_SIZE for index in range(page_count)]:
        page = pages[offset]
        items = page.get("item") if isinstance(page, dict) else None
        expected = min(PAGE_SIZE, total - offset)
        if not isinstance(items, list) or len(items) < expected:
            raise ValueError(
                f"扶摇全市场分页不完整: {offset}/{total}"
            )
        rows.extend(items)
        if _number(page.get("timestamp")) is not None:
            timestamps.append(page["timestamp"])
    unique = {
        str(row.get("ticker") or ""): row
        for row in rows
        if str(row.get("ticker") or "").isdigit()
        and len(str(row.get("ticker"))) == 6
    }
    if len(unique) != total:
        raise ValueError(
            f"扶摇全市场快照不完整: {len(unique)}/{total}"
        )
    target = _trade_date(max(timestamps)) if timestamps else None
    if not target:
        raise ValueError("扶摇全市场快照缺少交易日期")
    mapped = {}
    for code, row in unique.items():
        close = _number(row.get("last_price"))
        open_price = _number(row.get("open_price"))
        high = _number(row.get("high_price"))
        low = _number(row.get("low_price"))
        if (
            close is None
            or open_price is None
            or high is None
            or low is None
            or min(close, open_price, low) <= 0
            or high < max(open_price, close)
            or low > min(open_price, close)
        ):
            continue
        mapped[code] = {
            "date": target,
            "code": code,
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "preClose": _number(row.get("prev_price")),
            "volume": _number(row.get("volume")) or 0.0,
            "amount": _number(row.get("turnover")) or 0.0,
            "source": SOURCE,
        }
    if len(mapped) < 800:
        raise ValueError("扶摇全市场有效行情覆盖不足")
    return {
        "date": target,
        "total": total,
        "rows": mapped,
        "coverage": len(mapped) / total,
        "source": SOURCE,
    }
