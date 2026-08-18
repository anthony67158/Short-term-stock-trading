import importlib.util
import os
import sys
import unittest

import numpy as np


HERE = os.path.dirname(os.path.abspath(__file__))


def load_app():
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    spec = importlib.util.spec_from_file_location(
        "quant_app_under_test",
        os.path.join(HERE, "app.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.garch_sigma = lambda values, fallback: fallback
    return module


def factors():
    returns = np.asarray([
        0.2, -0.1, 0.4, 0.3, -0.2,
        0.5, 0.1, -0.3, 0.2, 0.4,
    ] * 8)
    return {
        "_rets": returns,
        "_last": 10.0,
        "_ma20": 9.8,
        "mom20": 3.0,
        "mean_rev": 0.5,
        "rsi": 55.0,
    }


class ForecastContractTest(unittest.TestCase):
    def test_outputs_next_trade_day_and_keeps_legacy_five_day_forecast(self):
        app = load_app()

        output = app.forecast_outputs(factors())

        self.assertEqual(output["forecast"]["days"], 5)
        self.assertEqual(
            output["forecast"]["horizon"],
            "next5TradingDays",
        )
        next_day = output["nextTradeDayForecast"]
        self.assertEqual(next_day["days"], 1)
        self.assertEqual(next_day["horizon"], "nextTradingDay")
        self.assertEqual(next_day["rangeType"], "P10-P90")
        self.assertEqual(
            next_day["forecastEngine"],
            "historicalVolMonteCarlo",
        )
        self.assertGreaterEqual(next_day["upProb"], 0)
        self.assertLessEqual(next_day["upProb"], 100)
        self.assertLessEqual(next_day["targetLow"], next_day["targetMid"])
        self.assertLessEqual(next_day["targetMid"], next_day["targetHigh"])

    def test_daily_model_explicitly_refuses_to_fake_same_day_range(self):
        app = load_app()

        availability = app.forecast_availability(realtime={"live": True})

        self.assertTrue(availability["nextTradeDay"])
        self.assertFalse(availability["currentSession"])
        self.assertEqual(
            availability["currentSessionReason"],
            "daily_model_has_no_intraday_remaining-session_label",
        )

    def test_current_trading_day_forecast_uses_previous_completed_daily_bar(self):
        app = load_app()

        output = app.forecast_outputs(
            factors(),
            previous_f=factors(),
            source_as_of="2026-08-17",
            target_date="2026-08-18",
        )

        current = output["currentTradingDayForecast"]
        self.assertEqual(current["days"], 1)
        self.assertEqual(current["sourceAsOf"], "2026-08-17")
        self.assertEqual(current["targetDate"], "2026-08-18")
        self.assertEqual(current["scope"], "fullTradingDayFromPreviousClose")
        self.assertEqual(current["rangeType"], "P10-P90")


if __name__ == "__main__":
    unittest.main()
