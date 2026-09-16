"""Versioned cash-equity fee assumptions for historical simulation."""

from decimal import Decimal, ROUND_HALF_UP

FEN = Decimal("0.01")

CASH_EQUITY_FEE_POLICY = {
    "policyVersion": "a-share-cash-equity-fees.v1",
    "brokerCommission": {
        "rate": "0.0003",
        "minimumCnyPerOrder": "5",
        "kind": "SIMULATION_ASSUMPTION",
    },
    "stampDuty": {
        "side": "SELL",
        "before20230828Rate": "0.001",
        "from20230828Rate": "0.0005",
        "sourceUrl": "https://m.mof.gov.cn/zcfb/202308/t20230827_3904226.htm",
    },
    "transferFee": {
        "side": "BOTH",
        "before20220429ShanghaiShenzhenRate": "0.00002",
        "before20220429BeijingRate": "0.000025",
        "from20220429Rate": "0.00001",
        "sourceUrl": (
            "http://finance.ce.cn/stock/gsgdbd/202204/28/"
            "t20220428_37541165.shtml"
        ),
    },
    "marketExitSlippageBps": {
        "value": "5",
        "kind": "SIMULATION_ASSUMPTION",
    },
}


def _money(value: Decimal) -> Decimal:
    return value.quantize(FEN, rounding=ROUND_HALF_UP)


def stamp_duty_rate(trade_date: str) -> Decimal:
    return Decimal("0.0005") if trade_date >= "20230828" else Decimal("0.001")


def transfer_fee_rate(board: str, trade_date: str) -> Decimal:
    if trade_date >= "20220429":
        return Decimal("0.00001")
    return Decimal("0.000025") if board == "BEIJING" else Decimal("0.00002")


def calculate_cash_equity_fees(
    *,
    side: str,
    gross_amount: Decimal,
    board: str,
    trade_date: str,
) -> dict[str, Decimal]:
    if side not in {"BUY", "SELL"} or board not in {
        "MAIN",
        "CHINEXT",
        "STAR",
        "BEIJING",
    }:
        raise ValueError("CASH_EQUITY_FEE_INPUT_INVALID")
    if gross_amount <= 0:
        raise ValueError("CASH_EQUITY_GROSS_AMOUNT_INVALID")
    commission = _money(max(Decimal("5"), gross_amount * Decimal("0.0003")))
    transfer = _money(gross_amount * transfer_fee_rate(board, trade_date))
    stamp = (
        _money(gross_amount * stamp_duty_rate(trade_date))
        if side == "SELL"
        else Decimal("0")
    )
    return {
        "commissionCny": commission,
        "transferFeeCny": transfer,
        "stampDutyCny": stamp,
        "totalCny": commission + transfer + stamp,
    }
