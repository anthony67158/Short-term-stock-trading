from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from platform_app.modules.experiments.cash_equity_fees import (
    calculate_cash_equity_fees,
    stamp_duty_rate,
    transfer_fee_rate,
)
from platform_app.modules.experiments.short_horizon_labeler import (
    order_size_scenarios,
    simulate_buy_limit_episode,
)
from platform_app.modules.experiments.short_horizon_policy import SHORT_HORIZON_POLICY


def _bars(dates, *, price="10", volume="10000"):
    rows = []
    for trade_date in dates:
        starts = (
            datetime.fromisoformat(
                f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:]} 09:35:00"
            ),
            datetime.fromisoformat(
                f"{trade_date[:4]}-{trade_date[4:6]}-{trade_date[6:]} 13:05:00"
            ),
        )
        for start in starts:
            for offset in range(24):
                rows.append(
                    {
                        "tradeDate": trade_date,
                        "barEndShanghai": (
                            start + timedelta(minutes=5 * offset)
                        ).strftime("%Y-%m-%d %H:%M:%S"),
                        "open": price,
                        "high": price,
                        "low": price,
                        "close": price,
                        "volumeShares": volume,
                    }
                )
    return rows


def _simulate(bars, dates):
    return simulate_buy_limit_episode(
        instrument_id="SZ.000001",
        board="MAIN",
        decision_date="20260101",
        trade_dates=dates,
        decision_close="10",
        bars=bars,
        terminal_close="10.5",
        execution_policy=SHORT_HORIZON_POLICY["executionPolicy"],
        label_policy=SHORT_HORIZON_POLICY["labelPolicy"],
        target_shares=10000,
    )


def test_historical_fee_rates_follow_effective_dates():
    assert transfer_fee_rate("MAIN", "20220428") == Decimal("0.00002")
    assert transfer_fee_rate("BEIJING", "20220428") == Decimal("0.000025")
    assert transfer_fee_rate("BEIJING", "20220429") == Decimal("0.00001")
    assert stamp_duty_rate("20230827") == Decimal("0.001")
    assert stamp_duty_rate("20230828") == Decimal("0.0005")
    assert calculate_cash_equity_fees(
        side="SELL",
        gross_amount=Decimal("100000"),
        board="MAIN",
        trade_date="20230828",
    ) == {
        "commissionCny": Decimal("30.00"),
        "transferFeeCny": Decimal("1.00"),
        "stampDutyCny": Decimal("50.00"),
        "totalCny": Decimal("81.00"),
    }


def test_limit_entry_respects_participation_and_records_partial_fill():
    dates = [f"2026010{day}" for day in range(2, 7)]
    result = _simulate(_bars(dates), dates)

    assert result["pFillLabel"] == 1
    assert result["targetShares"] == 10000
    assert result["filledShares"] == 3000
    assert result["fillRatio"] == "0.3"
    assert result["exitReason"] == "TERMINAL"
    assert result["pWinGivenFillLabel"] == 1


def test_limit_below_market_produces_no_fill_without_conditional_targets():
    dates = [f"2026010{day}" for day in range(2, 7)]
    result = _simulate(_bars(dates, price="10.1"), dates)

    assert result["pFillLabel"] == 0
    assert result["fillRatio"] == "0"
    assert result["netReturnGivenFill"] is None
    assert result["stopHazardLabel"] is None


def test_entry_day_stop_is_deferred_to_next_session_for_t_plus_one():
    dates = [f"2026010{day}" for day in range(2, 7)]
    bars = _bars(dates)
    bars[0]["low"] = "9.5"
    bars[48]["open"] = "9.6"
    bars[48]["low"] = "9.5"

    result = _simulate(bars, dates)

    assert result["filledShares"] == 500
    assert result["exitReason"] == "T1_DEFERRED_STOP"
    assert result["exitDate"] == dates[1]
    assert result["exitPrice"] == "9.5952"
    assert result["stopHazardLabel"] == 1


def test_same_bar_stop_and_take_uses_stop_first():
    dates = [f"2026010{day}" for day in range(2, 7)]
    bars = _bars(dates, volume="100000")
    bars[48].update({"open": "10", "low": "9", "high": "11", "close": "10"})

    result = _simulate(bars, dates)

    assert result["filledShares"] == 10000
    assert result["exitReason"] == "STOP"
    assert result["exitPrice"] == "9.69515"
    assert result["stopHazardLabel"] == 1


def test_high_price_stock_keeps_one_lot_when_reference_is_too_small():
    dates = [f"2026010{day}" for day in range(2, 7)]
    scenarios = order_size_scenarios(
        decision_close="1001",
        median_amount20_cny="100000000",
    )

    assert "ONE_BOARD_LOT" in scenarios[0]["scenarioIds"]
    assert scenarios[0]["targetShares"] == 100
    assert not any(row["reference100k"] for row in scenarios)
    result = simulate_buy_limit_episode(
        instrument_id="SH.600000",
        board="MAIN",
        decision_date="20260101",
        trade_dates=dates,
        decision_close="1001",
        bars=_bars(dates, price="1001"),
        terminal_close="1001",
        execution_policy=SHORT_HORIZON_POLICY["executionPolicy"],
        label_policy=SHORT_HORIZON_POLICY["labelPolicy"],
        target_shares=100,
    )
    assert result["pFillLabel"] == 1


def test_target_shares_must_be_a_board_lot():
    dates = [f"2026010{day}" for day in range(2, 7)]
    with pytest.raises(ValueError, match="LABEL_TARGET_SHARES_INVALID"):
        simulate_buy_limit_episode(
            instrument_id="SH.600000",
            board="MAIN",
            decision_date="20260101",
            trade_dates=dates,
            decision_close="1001",
            bars=_bars(dates, price="1001"),
            terminal_close="1001",
            execution_policy=SHORT_HORIZON_POLICY["executionPolicy"],
            label_policy=SHORT_HORIZON_POLICY["labelPolicy"],
            target_shares=50,
        )
