from decimal import Decimal

import numpy as np

from platform_app.modules.experiments.account_backtest import replay_account


class _PositiveBundle:
    @staticmethod
    def predict_matrix(*, base_values, scenario_values):
        count = len(base_values)
        assert len(scenario_values) == count
        return {
            "pFill": np.full(count, 0.8),
            "pFullFill": np.full(count, 0.7),
            "pWinGivenFill": np.full(count, 0.6),
            "q10": np.full(count, -0.02),
            "q50": np.full(count, 0.01),
            "q90": np.full(count, 0.04),
            "expectedNetReturnGivenFill": np.full(count, 0.02),
            "stopHazard": np.full(count, 0.2),
        }


def _candidate():
    return {
        "instrumentId": "SH.600001",
        "board": "MAIN",
        "rankPosition": 1,
        "medianAmount20Cny": "100000000",
        "baseFeatures": [0.1],
        "path": {
            "instrumentId": "SH.600001",
            "board": "MAIN",
            "decisionDate": "20250101",
            "entryDate": "20250102",
            "entryPrice": "10",
            "fillCapacityShares": 100,
            "exitPrice": "11",
            "exitReason": "TERMINAL",
            "exitDate": "20250103",
        },
    }


def test_account_replay_reserves_target_but_books_only_actual_partial_fill():
    result = replay_account(
        candidates_by_date={
            "20250101": [_candidate()],
            "20250102": [],
            "20250103": [],
        },
        close_prices={("20250102", "SH.600001"): Decimal("10.5")},
        bundle=_PositiveBundle(),
        initial_cash=Decimal("100000"),
        max_positions=1,
    )

    assert result["counts"]["ordersPlanned"] == 1
    assert result["counts"]["ordersExecuted"] == 1
    assert result["maxConcurrentPositions"] == 1
    assert result["trades"][0]["filledShares"] == 100
    assert Decimal(result["finalCashCny"]) > Decimal(result["initialCashCny"])
    assert Decimal(result["stressFinalCashCny"]) < Decimal(result["finalCashCny"])
    assert result["stressNetReturn"] > 0
