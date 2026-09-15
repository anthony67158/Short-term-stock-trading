import json

import httpx
import pytest
from pydantic import SecretStr

from platform_app.adapters import market_tushare
from platform_app.adapters.market_tushare import (
    HistoricalMarketError,
    TushareClient,
    instrument_parts,
    normalize_daily,
    normalize_minute,
    validate_endpoint,
)
from platform_app.config import settings


def test_instrument_identity_covers_all_a_share_boards():
    assert instrument_parts("000001.SZ")[2] == "MAIN"
    assert instrument_parts("300001.SZ")[2] == "CHINEXT"
    assert instrument_parts("688001.SH")[2] == "STAR"
    assert instrument_parts("920000.BJ")[2] == "BEIJING"
    assert instrument_parts("839729.BJ")[2] == "BEIJING"
    for value in ("000001.SH", "920000.SZ", "AAPL.US", "600000"):
        with pytest.raises(HistoricalMarketError):
            instrument_parts(value)


def test_daily_and_minute_normalize_units_without_binary_float_math():
    daily = normalize_daily({
        "ts_code": "300001.SZ",
        "trade_date": "20260915",
        "open": "10.01",
        "high": "10.20",
        "low": "9.90",
        "close": "10.10",
        "pre_close": "10.00",
        "vol": "123.45",
        "amount": "124.678",
    })
    assert daily["instrumentId"] == "SZ.300001"
    assert daily["volumeShares"] == "12345.00"
    assert daily["amountCny"] == "124678.000"
    minute = normalize_minute({
        "ts_code": "688001.SH",
        "trade_time": "2026-09-15 09:35:00",
        "open": "20.01",
        "high": "20.20",
        "low": "19.90",
        "close": "20.10",
        "vol": "12345",
        "amount": "247000.50",
    }, "SH.688001")
    assert minute["volumeShares"] == "12345"
    assert minute["amountCny"] == "247000.50"
    with pytest.raises(HistoricalMarketError, match="INVALID_OHLC"):
        normalize_daily({**{
            "ts_code": "300001.SZ", "trade_date": "20260915",
            "open": "10", "high": "9", "low": "8", "close": "10", "pre_close": "10",
            "vol": "1", "amount": "1",
        }})


def test_endpoint_allowlist_and_protocol_response(monkeypatch):
    assert validate_endpoint("https://ts.gyzcloud.top/api").startswith("https://")
    for value in (
        "http://ts.gyzcloud.top/api",
        "https://user@ts.gyzcloud.top/api",
        "https://example.com/api",
        "https://ts.gyzcloud.top/api?token=secret",
    ):
        with pytest.raises(HistoricalMarketError, match="MARKET_DATA_ENDPOINT_REJECTED"):
            validate_endpoint(value)

    config = settings().model_copy(update={
        "market_data_enabled": True,
        "market_data_api_key": SecretStr("synthetic"),
        "market_data_base_url": "https://ts.gyzcloud.top/api",
    })
    monkeypatch.setattr(market_tushare, "settings", lambda: config)
    calls = []

    def handle(request):
        body = json.loads(request.content)
        assert body["token"] == "synthetic"
        calls.append(str(request.url))
        if request.url.host == "ts.gyzcloud.top":
            return httpx.Response(307, headers={"location": "https://ts2.gyzcloud.top/api"})
        return httpx.Response(200, json={
            "code": 0,
            "data": {"fields": ["ts_code"], "items": [["000001.SZ"]]},
        })

    client = TushareClient(transport=httpx.MockTransport(handle))
    assert client.rows("daily", {"trade_date": "20260915"}, "ts_code") == [
        {"ts_code": "000001.SZ"}
    ]
    assert calls == ["https://ts.gyzcloud.top/api", "https://ts2.gyzcloud.top/api"]


def test_redirect_cannot_send_market_credential_to_untrusted_host(monkeypatch):
    config = settings().model_copy(update={
        "market_data_enabled": True,
        "market_data_api_key": SecretStr("synthetic"),
    })
    monkeypatch.setattr(market_tushare, "settings", lambda: config)
    client = TushareClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(307, headers={"location": "https://example.com/api"})
    ))
    with pytest.raises(HistoricalMarketError, match="MARKET_DATA_ENDPOINT_REJECTED"):
        client.rows("daily", {}, "ts_code")
