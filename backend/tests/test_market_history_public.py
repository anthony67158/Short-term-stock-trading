import httpx
import pytest

from platform_app.adapters.market_history_public import (
    PublicHistoryError,
    SinaDailyClient,
    TencentDailyClient,
)


def test_sina_daily_client_normalizes_unadjusted_daily_bar():
    def handler(request):
        assert request.url.host == "quotes.sina.cn"
        assert request.url.params["symbol"] == "bj920000"
        assert request.url.params["scale"] == "240"
        return httpx.Response(
            200,
            json={
                "result": {
                    "status": {"code": 0},
                    "data": [
                        {
                            "day": "2022-11-15",
                            "open": "5.450",
                            "high": "5.500",
                            "low": "5.360",
                            "close": "5.460",
                            "volume": "67479",
                        }
                    ],
                }
            },
        )

    rows = SinaDailyClient(transport=httpx.MockTransport(handler)).bars("BJ.920000")

    assert rows == {
        "20221115": {
            "tradeDate": "20221115",
            "open": "5.450",
            "high": "5.500",
            "low": "5.360",
            "close": "5.460",
            "volumeShares": "67479",
        }
    }


def test_tencent_daily_client_converts_lots_to_shares():
    def handler(request):
        assert request.url.host == "web.ifzq.gtimg.cn"
        assert request.url.params["param"] == "sz000001,day,2026-09-15,2026-09-15,1023,"
        return httpx.Response(
            200,
            json={
                "code": 0,
                "msg": "",
                "data": {
                    "sz000001": {
                        "day": [
                            [
                                "2026-09-15",
                                "11.820",
                                "11.820",
                                "11.880",
                                "11.770",
                                "755251.000",
                            ]
                        ]
                    }
                },
            },
        )

    rows = TencentDailyClient(transport=httpx.MockTransport(handler)).bars(
        "SZ.000001", "20260915", "20260915"
    )

    assert rows["20260915"]["volumeShares"] == "75525100.000"
    assert rows["20260915"]["high"] == "11.880"


def test_tencent_daily_client_keeps_star_market_volume_in_shares():
    client = TencentDailyClient(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "sh688001": {
                            "day": [
                                [
                                    "2022-11-15",
                                    "29.380",
                                    "30.700",
                                    "30.770",
                                    "29.190",
                                    "1718381.000",
                                ]
                            ]
                        }
                    },
                },
            )
        )
    )

    rows = client.bars("SH.688001", "20221115", "20221115")

    assert rows["20221115"]["volumeShares"] == "1718381.000"


def test_public_daily_clients_reject_duplicate_dates_and_invalid_shapes():
    sina = SinaDailyClient(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                json={
                    "result": {
                        "status": {"code": 0},
                        "data": [
                            {
                                "day": "2026-09-15",
                                "open": "1",
                                "high": "1",
                                "low": "1",
                                "close": "1",
                                "volume": "1",
                            },
                            {
                                "day": "2026-09-15",
                                "open": "1",
                                "high": "1",
                                "low": "1",
                                "close": "1",
                                "volume": "1",
                            },
                        ],
                    }
                },
            )
        )
    )
    with pytest.raises(PublicHistoryError, match="SINA_HISTORY_DUPLICATE_DATE"):
        sina.bars("SH.600000")

    tencent = TencentDailyClient(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                json={"code": 0, "data": {"sh600000": {"day": [["2026-09-15"]]}}},
            )
        )
    )
    with pytest.raises(PublicHistoryError, match="TENCENT_HISTORY_RESPONSE_INVALID"):
        tencent.bars("SH.600000", "20260915", "20260915")
