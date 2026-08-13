import copy
import json
import os
import sys
import tempfile
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from strategy_contract import strategy_fingerprint
from strategy_portfolio_backtest import main, run_portfolio_backtest


def strategy(**overrides):
    value = {
        "schemaVersion": "strategy-spec.v1",
        "strategyId": "test-strategy",
        "entry": {
            "type": "ALL",
            "conditions": [
                {"field": "marketScore", "op": "GTE", "value": 55},
                {"field": "quant.score", "op": "GTE", "value": 55},
            ],
        },
        "score": {
            "method": "WEIGHTED_SUM",
            "weights": {
                "marketScore": 0.4,
                "quantScore": 0.35,
                "upProb": 0.15,
                "expectedReturn": 0.1,
            },
            "bonuses": {"highConfidence": 5},
            "normalization": {
                "expectedReturnMin": -5,
                "expectedReturnMax": 5,
            },
        },
        "position": {
            "sizing": "EQUAL_WEIGHT",
            "allocationPct": 50,
            "maxPositions": 2,
            "lotSize": 100,
        },
        "exit": {
            "stopLossPct": 3,
            "takeProfitPct": 6,
            "maxHoldingDays": 5,
            "signalExit": None,
        },
        "execution": {
            "entryAt": "NEXT_OPEN",
            "exitAt": "NEXT_OPEN",
            "tPlusOne": True,
            "rejectLimitUpBuy": True,
            "rejectLimitDownSell": True,
            "slippageBps": 5,
            "feePolicy": "A_SHARE_STANDARD_V1",
        },
    }
    for key, patch in overrides.items():
        if isinstance(patch, dict) and isinstance(value.get(key), dict):
            value[key].update(copy.deepcopy(patch))
        else:
            value[key] = copy.deepcopy(patch)
    value["specVersion"] = strategy_fingerprint(value)
    return value


def bar(
    date,
    code,
    *,
    open_price=10,
    high=10.2,
    low=9.8,
    close=10,
    previous_close=10,
    volume=100_000,
    amount=100_000_000,
    turnover=2.0,
    listing_days=100,
    market_score=70,
    quant_score=0,
):
    return {
        "date": date,
        "code": code,
        "name": code,
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "previousClose": previous_close,
        "volume": volume,
        "amount": amount,
        "turnover": turnover,
        "listingDays": listing_days,
        "marketScore": market_score,
        "pct": (
            (close / previous_close - 1) * 100
            if previous_close
            else None
        ),
        "volRatio": 1.5,
        "quant": {
            "score": quant_score,
            "upProb": quant_score,
            "expRet": 2 if quant_score else 0,
            "highConfFired": False,
        },
    }


class PortfolioBacktestTest(unittest.TestCase):
    def test_filters_universe_and_market_ranking_before_entry_signal(self):
        spec = strategy(
            universe={
                "excludeSt": True,
                "excludeSuspended": True,
                "minimumListingDays": 20,
                "minimumAmount": 80_000_000,
            },
            marketRanking={
                "filters": {
                    "minPct": -6,
                    "maxPct": 8.8,
                    "minTurnover": 0.4,
                    "maxTurnover": 25,
                    "minVolRatio": 0.5,
                    "maxVolRatio": 8,
                },
            },
        )
        bars = [
            bar(
                "20260810",
                "600001.SH",
                amount=50_000_000,
                quant_score=80,
            ),
            bar(
                "20260810",
                "600002.SH",
                turnover=0.2,
                quant_score=80,
            ),
            bar("20260810", "600003.SH", quant_score=80),
            bar("20260811", "600001.SH"),
            bar("20260811", "600002.SH"),
            bar("20260811", "600003.SH"),
        ]

        report = run_portfolio_backtest(
            spec,
            bars,
            initial_cash=100_000,
        )

        self.assertEqual(report["metrics"]["openedTrades"], 1)
        self.assertEqual(
            [item["code"] for item in report["openPositions"]],
            ["600003.SH"],
        )

    def test_signal_at_close_enters_next_open_and_exits_t_plus_one(self):
        bars = [
            bar("20260810", "600001.SH", quant_score=75),
            bar(
                "20260811",
                "600001.SH",
                close=9.5,
                low=9.4,
                quant_score=0,
            ),
            bar(
                "20260812",
                "600001.SH",
                open_price=9.6,
                high=9.8,
                low=9.5,
                close=9.7,
                previous_close=9.5,
                quant_score=0,
            ),
        ]

        report = run_portfolio_backtest(
            strategy(),
            bars,
            initial_cash=100_000,
        )

        self.assertEqual(report["metrics"]["closedTrades"], 1)
        trade = report["trades"][0]
        self.assertEqual(trade["signalDate"], "20260810")
        self.assertEqual(trade["entryDate"], "20260811")
        self.assertEqual(trade["exitDate"], "20260812")
        self.assertEqual(trade["exitReason"], "STOP_LOSS")
        self.assertLess(trade["netPnl"], 0)
        self.assertGreater(trade["totalFees"], 0)

    def test_rejects_limit_up_entry_without_retrying_stale_signal(self):
        bars = [
            bar("20260810", "600001.SH", quant_score=80),
            bar(
                "20260811",
                "600001.SH",
                open_price=11,
                high=11,
                low=11,
                close=11,
                previous_close=10,
                quant_score=0,
            ),
            bar(
                "20260812",
                "600001.SH",
                open_price=10.8,
                previous_close=11,
                quant_score=0,
            ),
        ]

        report = run_portfolio_backtest(
            strategy(),
            bars,
            initial_cash=100_000,
        )

        self.assertEqual(report["metrics"]["openedTrades"], 0)
        self.assertEqual(report["rejections"][0]["reason"], "LIMIT_UP")

    def test_rejects_missing_previous_close_as_invalid_market_data(self):
        bars = [
            bar("20260810", "600001.SH", quant_score=80),
            bar(
                "20260811",
                "600001.SH",
                previous_close=None,
                quant_score=0,
            ),
        ]

        report = run_portfolio_backtest(
            strategy(),
            bars,
            initial_cash=100_000,
        )

        self.assertEqual(report["metrics"]["openedTrades"], 0)
        self.assertEqual(
            report["rejections"][0]["reason"],
            "INVALID_MARKET_DATA",
        )

    def test_retries_exit_after_limit_down_until_tradeable_open(self):
        spec = strategy(exit={"maxHoldingDays": 1})
        bars = [
            bar("20260810", "600001.SH", quant_score=80),
            bar("20260811", "600001.SH", quant_score=0),
            bar(
                "20260812",
                "600001.SH",
                open_price=9,
                high=9,
                low=9,
                close=9,
                previous_close=10,
                quant_score=0,
            ),
            bar(
                "20260813",
                "600001.SH",
                open_price=9.2,
                high=9.4,
                low=9.1,
                close=9.3,
                previous_close=9,
                quant_score=0,
            ),
        ]

        report = run_portfolio_backtest(spec, bars, initial_cash=100_000)

        self.assertEqual(report["trades"][0]["exitDate"], "20260813")
        self.assertEqual(report["trades"][0]["exitReason"], "MAX_HOLD")
        self.assertTrue(any(
            item["reason"] == "LIMIT_DOWN"
            and item["date"] == "20260812"
            for item in report["rejections"]
        ))

    def test_ranks_signals_and_enforces_maximum_positions(self):
        spec = strategy(position={
            "allocationPct": 100,
            "maxPositions": 1,
        })
        bars = [
            bar("20260810", "600001.SH", quant_score=65),
            bar("20260810", "600002.SH", quant_score=90),
            bar("20260811", "600001.SH", quant_score=0),
            bar("20260811", "600002.SH", quant_score=0),
        ]

        report = run_portfolio_backtest(spec, bars, initial_cash=100_000)

        self.assertEqual(report["metrics"]["openedTrades"], 1)
        self.assertEqual(report["openPositions"][0]["code"], "600002.SH")
        self.assertTrue(any(
            item["code"] == "600001.SH"
            and item["reason"] == "MAX_POSITIONS"
            for item in report["rejections"]
        ))
        self.assertEqual(report["schemaVersion"], "strategy-backtest.v1")
        self.assertEqual(report["specVersion"], spec["specVersion"])

    def test_cli_writes_versioned_json_report(self):
        value = strategy()
        bars = [
            bar("20260810", "600001.SH", quant_score=75),
            bar("20260811", "600001.SH", quant_score=0),
        ]
        with tempfile.TemporaryDirectory() as directory:
            strategy_path = os.path.join(directory, "strategy.json")
            bars_path = os.path.join(directory, "bars.json")
            output_path = os.path.join(directory, "report.json")
            with open(strategy_path, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False)
            with open(bars_path, "w", encoding="utf-8") as handle:
                json.dump({"bars": bars}, handle, ensure_ascii=False)

            exit_code = main([
                "--strategy",
                strategy_path,
                "--bars",
                bars_path,
                "--out",
                output_path,
                "--initial-cash",
                "100000",
            ])

            self.assertEqual(exit_code, 0)
            with open(output_path, "r", encoding="utf-8") as handle:
                report = json.load(handle)
            self.assertEqual(report["schemaVersion"], "strategy-backtest.v1")
            self.assertEqual(report["specVersion"], value["specVersion"])


if __name__ == "__main__":
    unittest.main()
