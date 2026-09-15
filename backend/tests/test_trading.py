from datetime import date, datetime
from decimal import Decimal

import pytest
from hypothesis import given, strategies as st

from platform_app.kernel.trading import (
    Lot, consume_fifo, quantity_rule, trading_date, validate_order_quantity,
)


def test_board_quantity_and_verified_dates():
    today = date(2026, 9, 15)
    main = quantity_rule("SH", "MAIN", today)
    star = quantity_rule("SH", "STAR", today)
    beijing = quantity_rule("BJ", "BEIJING", today)
    validate_order_quantity(main, "BUY", 100)
    validate_order_quantity(star, "BUY", 201)
    validate_order_quantity(beijing, "BUY", 101)
    validate_order_quantity(main, "SELL", 50, 350)
    validate_order_quantity(main, "SELL", 150, 350)
    validate_order_quantity(star, "SELL", 150, 150)
    for rule, side, qty, available in [
        (main, "BUY", 101, 0), (star, "BUY", 100, 0), (beijing, "BUY", 99, 0),
        (main, "SELL", 51, 350), (main, "SELL", 400, 350),
        (star, "SELL", 150, 350), (main, "BUY", True, 0),
    ]:
        with pytest.raises(ValueError):
            validate_order_quantity(rule, side, qty, available)
    assert quantity_rule("SH", "MAIN", date(2026, 9, 16)).verified_through == date(2026, 9, 16)
    for day in [date(2026, 7, 5), date(2026, 9, 17)]:
        with pytest.raises(ValueError):
            quantity_rule("SH", "MAIN", day)


def test_t_plus_one_shanghai_and_fifo():
    day = trading_date(datetime.fromisoformat("2026-09-14T16:01:00+00:00"))
    assert day == date(2026, 9, 15)
    lots = [
        Lot("old", date(2026, 9, 14), 100, Decimal("1005.01")),
        Lot("today", day, 100, Decimal("1105")),
    ]
    with pytest.raises(ValueError, match="可卖股数不足"):
        consume_fifo(lots, 101, day)
    assert consume_fifo(lots, 100, day)[0].basis == Decimal("1005.01")


@given(cents=st.integers(1, 100_000_000), qty=st.integers(2, 10000), seed=st.integers(1, 9999))
def test_partial_sales_conserve_cost_to_last_cent(cents, qty, seed):
    take = seed % (qty - 1) + 1
    basis = Decimal(cents) / 100
    lot = Lot("buy", date(2026, 9, 14), qty, basis)
    first = consume_fifo([lot], take, date(2026, 9, 15))[0]
    remainder = Lot("buy", lot.acquired_date, qty - take, basis - first.basis)
    final = consume_fifo([remainder], remainder.quantity, date(2026, 9, 15))[0]
    assert first.basis + final.basis == basis
    assert first.quantity + final.quantity == qty
