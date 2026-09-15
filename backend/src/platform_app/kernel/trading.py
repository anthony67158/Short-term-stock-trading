"""Pure A-share accounting primitives; no market IO or implicit fee estimates."""

from dataclasses import dataclass
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo("Asia/Shanghai")
CENT = Decimal("0.01")


def money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def trading_date(value: datetime) -> date:
    if value.tzinfo is None:
        raise ValueError("成交时间必须包含时区")
    return value.astimezone(SHANGHAI).date()


@dataclass(frozen=True)
class QuantityRule:
    version: str
    minimum: int
    step: int
    maximum: int
    effective_from: date
    verified_through: date


def quantity_rule(exchange: str, board: str, as_of: date) -> QuantityRule:
    # Only LIMIT auction orders. Sessions, permissions and price limits are separate gates.
    specs = {
        ("SH", "MAIN"): (100, 100, 1_000_000),
        ("SZ", "MAIN"): (100, 100, 1_000_000),
        ("SZ", "CHINEXT"): (100, 100, 300_000),
        ("SH", "STAR"): (200, 1, 100_000),
        ("BJ", "BEIJING"): (100, 1, 1_000_000),
    }
    start, verified = date(2026, 7, 6), date(2026, 9, 16)
    if not start <= as_of <= verified or (exchange, board) not in specs:
        raise ValueError("该证券或日期尚无已核验的限价申报规则")
    return QuantityRule(f"{exchange}-{board}-LIMIT-20260706", *specs[exchange, board],
                        start, verified)


def validate_order_quantity(rule: QuantityRule, side: str, quantity: int, available: int = 0):
    if type(quantity) is not int or quantity <= 0 or quantity > rule.maximum:
        raise ValueError("申报数量超出规则范围")
    if side not in {"BUY", "SELL"}:
        raise ValueError("买卖方向无效")
    if side == "SELL":
        if quantity > available:
            raise ValueError("申报数量超过可卖股数")
        if quantity == available:
            return
        # Main-board odd remainder must be sold together, possibly with full lots.
        if rule.step == 100 and quantity % 100 == available % 100:
            return
    if quantity < rule.minimum or quantity % rule.step:
        raise ValueError("申报数量不符合该板块最小数量或递增单位")


@dataclass(frozen=True)
class Lot:
    execution_id: str
    acquired_date: date
    quantity: int
    basis: Decimal


@dataclass(frozen=True)
class Consumption:
    execution_id: str
    quantity: int
    basis: Decimal


def consume_fifo(lots: list[Lot], quantity: int, sold_date: date) -> list[Consumption]:
    """Consume only settled lots; conserve the last cent when closing a lot."""
    if type(quantity) is not int or quantity <= 0:
        raise ValueError("成交股数必须是正整数")
    if sum(lot.quantity for lot in lots if lot.acquired_date < sold_date) < quantity:
        raise ValueError("可卖股数不足，请核对持仓和当日买入锁定数量")
    remaining, result = quantity, []
    for lot in lots:
        if lot.acquired_date >= sold_date or not lot.quantity:
            continue
        take = min(remaining, lot.quantity)
        basis = lot.basis if take == lot.quantity else money(lot.basis * take / lot.quantity)
        result.append(Consumption(lot.execution_id, take, basis))
        remaining -= take
        if not remaining:
            break
    return result
