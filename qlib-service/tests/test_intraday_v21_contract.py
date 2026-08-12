import importlib.util
import os
import unittest
from datetime import datetime, timedelta


HERE = os.path.dirname(os.path.abspath(__file__))
MODULE_PATH = os.path.join(HERE, "..", "intraday_v21_contract.py")


def load_contract():
    spec = importlib.util.spec_from_file_location(
        "intraday_v21_contract",
        MODULE_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def session_times(day):
    values = []
    current = datetime.strptime(f"{day} 09:35:00", "%Y-%m-%d %H:%M:%S")
    end = datetime.strptime(f"{day} 11:30:00", "%Y-%m-%d %H:%M:%S")
    while current <= end:
        values.append(current)
        current += timedelta(minutes=5)
    current = datetime.strptime(f"{day} 13:05:00", "%Y-%m-%d %H:%M:%S")
    end = datetime.strptime(f"{day} 15:00:00", "%Y-%m-%d %H:%M:%S")
    while current <= end:
        values.append(current)
        current += timedelta(minutes=5)
    return values


def valid_payload(as_of="2026-08-12 10:30:00"):
    moments = session_times("2026-08-11") + [
        value
        for value in session_times("2026-08-12")
        if value <= datetime.strptime(as_of, "%Y-%m-%d %H:%M:%S")
    ]
    moments = moments[-60:]
    bars = [{
        "tradeTime": moment.strftime("%Y-%m-%d %H:%M:%S"),
        "open": 10.0,
        "high": 10.1,
        "low": 9.9,
        "close": 10.0,
        "volume": 1000.0,
    } for moment in moments]
    return {
        "requestId": "v21_20260812_1030_600519",
        "code": "600519.SH",
        "asOf": as_of,
        "bars": bars,
    }


class IntradayV21ContractTest(unittest.TestCase):
    def test_accepts_completed_intraday_bar_and_identifies_session(self):
        contract = load_contract()

        request = contract.validate_predict_v21_payload(valid_payload())

        self.assertEqual(request["as_of"], "2026-08-12 10:30:00")
        self.assertEqual(request["session"], "morning")
        self.assertEqual(len(request["panel"]["trade_time"]), 60)

    def test_accepts_noon_signal_as_afternoon_forecast_boundary(self):
        contract = load_contract()

        request = contract.validate_predict_v21_payload(
            valid_payload("2026-08-12 11:30:00")
        )

        self.assertEqual(request["session"], "noon")

    def test_rejects_unsupported_or_unfinished_signal_time(self):
        contract = load_contract()
        with self.assertRaisesRegex(ValueError, "时点"):
            contract.validate_predict_v21_payload(
                valid_payload("2026-08-12 09:55:00")
            )
        with self.assertRaisesRegex(ValueError, "时点"):
            contract.validate_predict_v21_payload(
                valid_payload("2026-08-12 14:35:00")
            )


if __name__ == "__main__":
    unittest.main()
