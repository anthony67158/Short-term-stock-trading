"""Validated TickFlow OHLCV adapter for immutable market archives."""

import concurrent.futures
import datetime as dt
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo


API_URL = "https://api.tickflow.org"
BATCH_SIZE = 100
SHANGHAI = ZoneInfo("Asia/Shanghai")
CODE_PATTERN = re.compile(r"^\d{6}$")
REQUIRED_COLUMNS = ("timestamp", "open", "high", "low", "close", "volume")
ARCHIVE_MODES = {"off", "shadow", "primary"}


def configured(env=None):
    source = env if env is not None else os.environ
    return bool(str(source.get("TICKFLOW_API_KEY") or "").strip())


def archive_mode(env=None):
    source = env if env is not None else os.environ
    value = str(source.get("TICKFLOW_ARCHIVE_MODE") or "off").strip().lower()
    return value if value in ARCHIVE_MODES else "off"


def _symbol(code):
    value = str(code or "").strip()
    if not CODE_PATTERN.fullmatch(value):
        raise ValueError(f"TickFlow股票代码非法: {value}")
    if re.match(r"^(4|8|92)", value):
        suffix = "BJ"
    elif re.match(r"^(6|9|5)", value):
        suffix = "SH"
    else:
        suffix = "SZ"
    return f"{value}.{suffix}"


def _day_bounds(date):
    day = dt.datetime.strptime(str(date), "%Y%m%d").date()
    start = dt.datetime.combine(day, dt.time.min, tzinfo=SHANGHAI)
    end = dt.datetime.combine(day, dt.time.max, tzinfo=SHANGHAI)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def _request_json(url, headers, *, timeout=30, attempts=3):
    last_error = None
    for attempt in range(max(1, attempts)):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code != 429 and error.code < 500:
                break
        except Exception as error:
            last_error = error
        if attempt + 1 < attempts:
            time.sleep(2 ** attempt)
    raise last_error or RuntimeError("TickFlow请求失败")


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _normalize_compact(data, code, date, *, period):
    if not isinstance(data, dict):
        return []
    columns = {}
    for name in REQUIRED_COLUMNS:
        values = data.get(name)
        if not isinstance(values, list):
            return []
        columns[name] = values
    size = len(columns["timestamp"])
    if not size or any(len(values) != size for values in columns.values()):
        return []
    amounts = data.get("amount")
    if not isinstance(amounts, list) or len(amounts) != size:
        amounts = [0.0] * size
    rows = {}
    for index in range(size):
        timestamp = _number(columns["timestamp"][index])
        if timestamp is None or timestamp <= 0:
            continue
        moment = dt.datetime.fromtimestamp(timestamp / 1000, tz=SHANGHAI)
        stamp = moment.strftime("%Y%m%d%H%M%S")
        if not stamp.startswith(date):
            continue
        open_price = _number(columns["open"][index])
        high = _number(columns["high"][index])
        low = _number(columns["low"][index])
        close = _number(columns["close"][index])
        volume = _number(columns["volume"][index])
        amount = _number(amounts[index])
        if (
            min(open_price or 0, close or 0, low or 0) <= 0
            or high is None
            or high < max(open_price, close)
            or low > min(open_price, close)
            or volume is None
            or volume < 0
        ):
            continue
        rows[stamp] = {
            "date": stamp,
            "code": code,
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
            "amount": max(0.0, amount or 0.0),
            "pre_close": None,
        }
    ordered = [rows[key] for key in sorted(rows)]
    if period == "5m":
        return ordered if 45 <= len(ordered) <= 60 else []
    return ordered if period == "1d" and len(ordered) == 1 else []


def fetch_klines(
    codes,
    date,
    *,
    period,
    workers=5,
    env=None,
    fetch_json=None,
):
    source = env if env is not None else os.environ
    api_key = str(source.get("TICKFLOW_API_KEY") or "").strip()
    if not api_key:
        return {}
    unique_codes = sorted({
        str(code).strip()
        for code in codes
        if CODE_PATTERN.fullmatch(str(code).strip())
    })
    start_time, end_time = _day_bounds(date)
    load = fetch_json or _request_json

    def fetch_chunk(chunk):
        symbols = [_symbol(code) for code in chunk]
        query = urllib.parse.urlencode({
            "symbols": ",".join(symbols),
            "period": period,
            "count": 60 if period == "5m" else 1,
            "start_time": start_time,
            "end_time": end_time,
            "adjust": "none",
        })
        payload = load(
            f"{API_URL}/v1/klines/batch?{query}",
            {"Accept": "application/json", "x-api-key": api_key},
        )
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict):
            return {}
        result = {}
        for code, symbol in zip(chunk, symbols):
            rows = _normalize_compact(
                data.get(symbol),
                code,
                date,
                period=period,
            )
            if rows:
                result[code] = rows
        return result

    chunks = [
        unique_codes[index:index + BATCH_SIZE]
        for index in range(0, len(unique_codes), BATCH_SIZE)
    ]
    result = {}
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=max(1, min(int(workers), 5)),
    ) as executor:
        futures = [executor.submit(fetch_chunk, chunk) for chunk in chunks]
        for future in concurrent.futures.as_completed(futures):
            try:
                result.update(future.result())
            except Exception:
                continue
    return result


def fetch_daily(codes, date, **kwargs):
    return fetch_klines(codes, date, period="1d", **kwargs)


def fetch_minutes(codes, date, **kwargs):
    return fetch_klines(codes, date, period="5m", **kwargs)
