"""Validated request contract for the isolated intraday shadow endpoint."""

import math
import re
from datetime import datetime

import numpy as np


CODE_RE = re.compile(r"^\d{6}\.(SH|SZ|BJ)$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
TIME_FORMAT = "%Y-%m-%d %H:%M:%S"
MIN_BARS = 61
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
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} 必须是数值") from error
    if not math.isfinite(number) or (positive and number <= 0):
        raise ValueError(f"{label} 数值无效")
    return number


def validate_predict_v2_payload(payload):
    """Validate external input and return an internal panel for inference."""
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是对象")
    unknown = set(payload) - PAYLOAD_KEYS
    if unknown:
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
    _parse_time(as_of, "asOf")
    bars = payload.get("bars")
    if not isinstance(bars, list) or not MIN_BARS <= len(bars) <= MAX_BARS:
        raise ValueError(f"bars 数量必须在 {MIN_BARS} 到 {MAX_BARS} 之间")

    trade_times = []
    opens = []
    highs = []
    lows = []
    closes = []
    volumes = []
    previous = None
    for index, bar in enumerate(bars):
        if not isinstance(bar, dict):
            raise ValueError(f"bars[{index}] 必须是对象")
        if set(bar) != BAR_KEYS:
            raise ValueError(f"bars[{index}] 字段无效")
        trade_time = bar["tradeTime"]
        parsed = _parse_time(trade_time, f"bars[{index}].tradeTime")
        if previous is not None and parsed <= previous:
            raise ValueError("bars.tradeTime 必须严格升序")
        previous = parsed
        open_ = _number(bar["open"], f"bars[{index}].open", positive=True)
        high = _number(bar["high"], f"bars[{index}].high", positive=True)
        low = _number(bar["low"], f"bars[{index}].low", positive=True)
        close = _number(bar["close"], f"bars[{index}].close", positive=True)
        volume = _number(bar["volume"], f"bars[{index}].volume")
        if volume < 0:
            raise ValueError(f"bars[{index}].volume 数值无效")
        if high < max(open_, close):
            raise ValueError("bars.high 小于 open 或 close")
        if low > min(open_, close):
            raise ValueError("bars.low 大于 open 或 close")
        trade_times.append(trade_time)
        opens.append(open_)
        highs.append(high)
        lows.append(low)
        closes.append(close)
        volumes.append(volume)

    if as_of != trade_times[-1]:
        raise ValueError("asOf 必须等于最后一根 bars.tradeTime")
    if not as_of.endswith("15:00:00"):
        raise ValueError("影子候选仅接受日终 15:00 输入")
    return {
        "request_id": request_id,
        "code": code,
        "as_of": as_of,
        "panel": {
            "trade_time": np.asarray(trade_times),
            "open": np.asarray(opens, dtype=np.float64),
            "high": np.asarray(highs, dtype=np.float64),
            "low": np.asarray(lows, dtype=np.float64),
            "close": np.asarray(closes, dtype=np.float64),
            "vol": np.asarray(volumes, dtype=np.float64),
            "amount": np.zeros(len(trade_times), dtype=np.float64),
        },
    }
