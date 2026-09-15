"""Published exchange calendars, not a mainland working-day calendar."""
from datetime import date, datetime, timedelta
from typing import Literal

from pydantic import AwareDatetime

from platform_app.contracts.base import Contract
from platform_app.kernel.trading import SHANGHAI

SOURCES = {
    "SH": "https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml",
    "SZ": "https://www.szse.cn/disclosure/notice/general/t20251222_618087.html",
    "BJ": "https://www.bse.cn/important_news/200027428.html",
}
AVAILABLE_AT = datetime(2025, 12, 23, tzinfo=SHANGHAI)
HOLIDAYS_2026 = (
    (date(2026, 1, 1), date(2026, 1, 3), "元旦"),
    (date(2026, 2, 15), date(2026, 2, 23), "春节"),
    (date(2026, 4, 4), date(2026, 4, 6), "清明节"),
    (date(2026, 5, 1), date(2026, 5, 5), "劳动节"),
    (date(2026, 6, 19), date(2026, 6, 21), "端午节"),
    (date(2026, 9, 25), date(2026, 9, 27), "中秋节"),
    (date(2026, 10, 1), date(2026, 10, 7), "国庆节"),
)


class CalendarDay(Contract):
    exchange: Literal["SH", "SZ", "BJ"]
    date: date
    is_trading_day: bool | None
    reason: str
    source_url: str | None
    version: str | None
    published_at: date | None
    available_at: AwareDatetime | None
    next_trading_day: date | None = None
    next_day_missing_reason: str | None = None
    calendar_scope: Literal["PUBLISHED_SCHEDULE"] = "PUBLISHED_SCHEDULE"


def scheduled_day(exchange: str, day: date, *, as_of: datetime | None = None) -> CalendarDay:
    if exchange not in SOURCES:
        raise ValueError("不支持的证券市场")
    if as_of is not None and as_of.tzinfo is None:
        raise ValueError("日历查询时点必须包含时区")
    if day.year != 2026 or (as_of is not None and as_of < AVAILABLE_AT):
        return CalendarDay(
            exchange=exchange, date=day, is_trading_day=None, reason="该时点没有可用的年度日历",
            source_url=None, version=None, published_at=None, available_at=None,
        )
    holiday = next((label for start, end, label in HOLIDAYS_2026 if start <= day <= end), None)
    return CalendarDay(
        exchange=exchange, date=day, is_trading_day=not holiday and day.weekday() < 5,
        reason=holiday or ("周末休市" if day.weekday() >= 5 else "按年度安排开市"),
        source_url=SOURCES[exchange], version=f"{exchange}-calendar-2026-v1",
        published_at=date(2025, 12, 22), available_at=AVAILABLE_AT,
    )


def calendar_day(exchange: str, day: date, *, as_of: datetime | None = None) -> CalendarDay:
    result = scheduled_day(exchange, day, as_of=as_of)
    if result.is_trading_day is None:
        return result.model_copy(update={"next_day_missing_reason": result.reason})
    candidate = day
    for _ in range(32):
        candidate += timedelta(days=1)
        following = scheduled_day(exchange, candidate, as_of=as_of)
        if following.is_trading_day is None:
            return result.model_copy(update={"next_day_missing_reason": "下一年度日历尚未核验"})
        if following.is_trading_day:
            return result.model_copy(update={"next_trading_day": candidate})
    return result.model_copy(update={"next_day_missing_reason": "未在已核验窗口内找到下一交易日"})
