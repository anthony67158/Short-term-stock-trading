"""Validated request contract for V2.1 intraday dual-head inference."""

import math
import re
from datetime import datetime

import numpy as np


CODE_RE = re.compile(r"^\d{6}\.(SH|SZ|BJ)$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
TIME_FORMAT = "%Y-%m-%d %H:%M:%S"
MIN_BARS = 60
MAX_BARS = 240
PAYLOAD_KEYS = frozenset({"requestId", "code", "asOf", "bars"})
BAR_KEYS = frozenset(
    {"tradeTime", "open", "high", "low", "close", "volume"}
)


def _parse_time(value, label):
    if not isinstance(value, str):
        raise ValueError(f"{label} 必须是时间字符串")
    try:
        parsed = datetime.strptime(value, TIME_FORMAT)
    except ValueError as error:
        raise ValueError(f"{label} 时间格式无效") from error
    if parsed.strftime(TIME_FORMAT) != value:
        raise ValueError(f"{label} 时间格式无效")
    return parsed


def _number(value, label, *, positive=False):
    if isinstance(value, bool):
        raise ValueError(f"{label} 必须是数值")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} 必须是数值") from error
    if not math.isfinite(result) or (positive and result <= 0):
        raise ValueError(f"{label} 数值无效")
    return result


def _valid_bar_time(value):
    hhmm = value.strftime("%H:%M")
    if value.minute % 5:
        return False
    return (
        "09:35" <= hhmm <= "11:30"
        or "13:05" <= hhmm <= "15:00"
    )


def _signal_session(parsed):
    hhmm = parsed.strftime("%H:%M")
    if "10:00" <= hhmm < "11:30":
        return "morning"
    if hhmm == "11:30":
        return "noon"
    if "13:05" <= hhmm <= "14:30":
        return "afternoon"
    raise ValueError("V2.1 盘中信号时点无效")


def validate_predict_v21_payload(payload):
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是对象")
    if set(payload) - PAYLOAD_KEYS:
        raise ValueError("请求包含未允许字段")
    code = payload.get("code")
    if not isinstance(code, str) or not CODE_RE.fullmatch(code):
        raise ValueError("股票代码无效")
    request_id = payload.get("requestId")
    if request_id is not None and (
        not isinstance(request_id, str)
        or not REQUEST_ID_RE.fullmatch(request_id)
    ):
        raise ValueError("requestId 无效")
    as_of = payload.get("asOf")
    as_of_time = _parse_time(as_of, "asOf")
    session = _signal_session(as_of_time)
    bars = payload.get("bars")
    if not isinstance(bars, list) or not MIN_BARS <= len(bars) <= MAX_BARS:
        raise ValueError(f"bars 数量必须在 {MIN_BARS} 到 {MAX_BARS} 之间")

    times = []
    opens = []
    highs = []
    lows = []
    closes = []
    volumes = []
    previous = None
    for index, bar in enumerate(bars):
        if not isinstance(bar, dict) or set(bar) != BAR_KEYS:
            raise ValueError(f"bars[{index}] 字段无效")
        parsed = _parse_time(
            bar["tradeTime"],
            f"bars[{index}].tradeTime",
        )
        if not _valid_bar_time(parsed):
            raise ValueError(f"bars[{index}] 不是合法5分钟交易时点")
        if previous is not None and parsed <= previous:
            raise ValueError("bars.tradeTime 必须严格升序")
        previous = parsed
        open_ = _number(bar["open"], f"bars[{index}].open", positive=True)
        high = _number(bar["high"], f"bars[{index}].high", positive=True)
        low = _number(bar["low"], f"bars[{index}].low", positive=True)
        close = _number(bar["close"], f"bars[{index}].close", positive=True)
        volume = _number(bar["volume"], f"bars[{index}].volume")
        if volume < 0 or high < max(open_, close) or low > min(open_, close):
            raise ValueError(f"bars[{index}] OHLCV 约束无效")
        times.append(bar["tradeTime"])
        opens.append(open_)
        highs.append(high)
        lows.append(low)
        closes.append(close)
        volumes.append(volume)
    if as_of != times[-1]:
        raise ValueError("asOf 必须等于最后一根 bars.tradeTime")
    return {
        "request_id": request_id,
        "code": code,
        "as_of": as_of,
        "session": session,
        "panel": {
            "trade_time": np.asarray(times),
            "open": np.asarray(opens, dtype=np.float64),
            "high": np.asarray(highs, dtype=np.float64),
            "low": np.asarray(lows, dtype=np.float64),
            "close": np.asarray(closes, dtype=np.float64),
            "vol": np.asarray(volumes, dtype=np.float64),
            "amount": np.zeros(len(times), dtype=np.float64),
        },
    }
