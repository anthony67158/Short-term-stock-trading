from datetime import date, datetime, timezone

import pytest

from platform_app.kernel.calendar import calendar_day, scheduled_day


@pytest.mark.parametrize("exchange", ["SH", "SZ", "BJ"])
def test_published_calendar_long_holidays_and_working_weekends(exchange):
    assert calendar_day(exchange, date(2026, 2, 13)).next_trading_day == date(2026, 2, 24)
    assert calendar_day(exchange, date(2026, 9, 30)).next_trading_day == date(2026, 10, 8)
    assert calendar_day(exchange, date(2026, 9, 24)).next_trading_day == date(2026, 9, 28)
    for day in [date(2026, 1, 4), date(2026, 2, 28), date(2026, 5, 9), date(2026, 9, 20)]:
        assert scheduled_day(exchange, day).is_trading_day is False
    assert scheduled_day(exchange, date(2026, 9, 15)).is_trading_day is True


def test_calendar_unknown_year_and_point_in_time_do_not_guess():
    result = calendar_day("SH", date(2026, 12, 31))
    assert result.is_trading_day is True
    assert result.next_trading_day is None
    assert result.next_day_missing_reason
    assert calendar_day("SH", date(2025, 9, 15)).is_trading_day is None
    assert calendar_day("SH", date(2026, 2, 13), as_of=datetime(
        2025, 1, 1, tzinfo=timezone.utc)).is_trading_day is None
