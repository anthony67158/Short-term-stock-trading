"""Conservative A-share execution and fee rules for offline evaluation."""

import math
from decimal import Decimal, ROUND_HALF_UP

import numpy as np


def price_limit_pct(code, trade_date, *, is_st=False):
    symbol, _, exchange = str(code).upper().partition(".")
    date = str(trade_date).replace("-", "")
    if exchange == "BJ" or symbol.startswith(("4", "8")):
        return 0.30
    if exchange == "SH" and symbol.startswith(("688", "689")):
        return 0.20
    if (
        exchange == "SZ"
        and symbol.startswith(("300", "301"))
        and date >= "20200824"
    ):
        return 0.20
    if is_st:
        return 0.05
    return 0.10


def _price_tick(value):
    return float(
        Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    )


def _execution_tick(value):
    return float(
        Decimal(str(value)).quantize(
            Decimal("0.000001"),
            rounding=ROUND_HALF_UP,
        )
    )


def _positive_finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(number) and number > 0


def limit_prices(previous_close, limit_pct):
    if not _positive_finite(previous_close):
        raise ValueError("previous_close must be positive and finite")
    if not math.isfinite(limit_pct) or not 0 < limit_pct < 1:
        raise ValueError("limit_pct must be between zero and one")
    lower = _price_tick(previous_close * (1.0 - limit_pct))
    upper = _price_tick(previous_close * (1.0 + limit_pct))
    return lower, upper


def can_fill_open(*, side, previous_close, open_price, volume, limit_pct):
    if side not in ("buy", "sell"):
        raise ValueError("side must be 'buy' or 'sell'")
    if (
        not _positive_finite(previous_close)
        or not _positive_finite(open_price)
        or not _positive_finite(volume)
    ):
        return False
    lower, upper = limit_prices(previous_close, limit_pct)
    if side == "buy":
        return open_price < upper
    return open_price > lower


def trade_fees(
    side,
    gross_amount,
    *,
    commission_rate=0.0003,
    minimum_commission=5.0,
    stamp_duty_rate=0.0005,
    transfer_rate=0.00001,
):
    if side not in ("buy", "sell"):
        raise ValueError("side must be 'buy' or 'sell'")
    if not math.isfinite(gross_amount) or gross_amount <= 0:
        raise ValueError("gross_amount must be positive and finite")
    raw_commission = max(
        minimum_commission,
        gross_amount * commission_rate,
    )
    raw_stamp_duty = (
        gross_amount * stamp_duty_rate if side == "sell" else 0.0
    )
    raw_transfer = gross_amount * transfer_rate
    return {
        "commission": _price_tick(raw_commission),
        "stamp_duty": _price_tick(raw_stamp_duty),
        "transfer": _price_tick(raw_transfer),
        "total": _price_tick(
            raw_commission + raw_stamp_duty + raw_transfer
        ),
    }


def execution_price(open_price, side, slippage_bps):
    if side not in ("buy", "sell"):
        raise ValueError("side must be 'buy' or 'sell'")
    if not math.isfinite(slippage_bps) or slippage_bps < 0:
        raise ValueError("slippage_bps must be non-negative and finite")
    slippage = slippage_bps / 10_000.0
    multiplier = 1.0 + slippage if side == "buy" else 1.0 - slippage
    return _execution_tick(float(open_price) * multiplier)


def simulate_long_trade(
    *,
    code,
    dates,
    opens,
    closes,
    volumes,
    signal_index,
    requested_exit_index,
    quantity,
    slippage_bps=5,
    is_st=False,
):
    dates = np.asarray(dates).astype(str)
    opens = np.asarray(opens, dtype=float)
    closes = np.asarray(closes, dtype=float)
    volumes = np.asarray(volumes, dtype=float)
    if not (len(dates) == len(opens) == len(closes) == len(volumes)):
        raise ValueError("market arrays must have equal length")
    if (
        not isinstance(signal_index, (int, np.integer))
        or signal_index < 0
        or signal_index + 1 >= len(dates)
    ):
        raise ValueError("signal_index must have a following trading day")
    if not isinstance(requested_exit_index, (int, np.integer)):
        raise ValueError("requested_exit_index must be an integer")
    if not isinstance(quantity, (int, np.integer)) or quantity <= 0:
        raise ValueError("quantity must be a positive integer")
    if quantity % 100:
        raise ValueError("A-share buy quantity must be a multiple of 100")

    entry_index = signal_index + 1
    entry_limit = price_limit_pct(
        code,
        dates[entry_index],
        is_st=is_st,
    )
    if not can_fill_open(
        side="buy",
        previous_close=closes[entry_index - 1],
        open_price=opens[entry_index],
        volume=volumes[entry_index],
        limit_pct=entry_limit,
    ):
        return {"status": "entry_unfilled", "entry_index": entry_index}

    entry_price = execution_price(opens[entry_index], "buy", slippage_bps)
    entry_gross = entry_price * quantity
    entry_fees = trade_fees("buy", entry_gross)
    exit_start = max(int(requested_exit_index), entry_index + 1)

    for exit_index in range(exit_start, len(dates)):
        exit_limit = price_limit_pct(
            code,
            dates[exit_index],
            is_st=is_st,
        )
        if not can_fill_open(
            side="sell",
            previous_close=closes[exit_index - 1],
            open_price=opens[exit_index],
            volume=volumes[exit_index],
            limit_pct=exit_limit,
        ):
            continue
        exit_price = execution_price(opens[exit_index], "sell", slippage_bps)
        exit_gross = exit_price * quantity
        exit_fees = trade_fees("sell", exit_gross)
        pnl = (
            exit_gross
            - exit_fees["total"]
            - entry_gross
            - entry_fees["total"]
        )
        return {
            "status": "closed",
            "entry_index": entry_index,
            "exit_index": exit_index,
            "entry_price": entry_price,
            "exit_price": exit_price,
            "entry_fees": entry_fees["total"],
            "exit_fees": exit_fees["total"],
            "pnl": pnl,
            "net_return": pnl / (entry_gross + entry_fees["total"]),
        }

    return {
        "status": "exit_unfilled",
        "entry_index": entry_index,
        "entry_price": entry_price,
        "entry_fees": entry_fees["total"],
    }
