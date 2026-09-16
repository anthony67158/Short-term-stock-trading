import httpx
import pytest

from platform_app.modules.experiments.combination_finalize import (
    fetch_with_transport_retry,
)


class Fetcher:
    def __init__(self, failures):
        self.failures = failures
        self.calls = 0

    def fetch_window(self, window):
        self.calls += 1
        if self.calls <= self.failures:
            raise httpx.ConnectTimeout("synthetic")
        return {"status": "COMPLETED", "instrumentId": window["instrumentId"]}


def test_transport_failure_is_retried_without_changing_window():
    fetcher = Fetcher(failures=2)
    sleeps = []
    window = {"instrumentId": "SH.600000", "sourceCode": "600000.SH"}
    assert fetch_with_transport_retry(fetcher, window, sleep=sleeps.append) == {
        "status": "COMPLETED",
        "instrumentId": "SH.600000",
    }
    assert fetcher.calls == 3
    assert sleeps == [1, 2]


def test_transport_failure_remains_fatal_after_bound():
    fetcher = Fetcher(failures=3)
    with pytest.raises(httpx.ConnectTimeout):
        fetch_with_transport_retry(
            fetcher,
            {"instrumentId": "BJ.920000"},
            attempts=3,
            sleep=lambda _: None,
        )
    assert fetcher.calls == 3


def test_market_validation_failure_is_not_retried():
    class Invalid:
        calls = 0

        def fetch_window(self, _window):
            self.calls += 1
            raise ValueError("INVALID_OHLC")

    fetcher = Invalid()
    with pytest.raises(ValueError, match="INVALID_OHLC"):
        fetch_with_transport_retry(fetcher, {"instrumentId": "SH.600000"})
    assert fetcher.calls == 1
