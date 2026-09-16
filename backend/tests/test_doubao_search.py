import asyncio
import json

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from platform_app.adapters.doubao_search import (
    DoubaoSearchClient,
    SearchFailure,
    SearchRequest,
)
from platform_app.config import settings


def _config(**updates):
    return settings().model_copy(
        update={
            "search_enabled": True,
            "search_api_key": SecretStr("synthetic-search-key"),
            **updates,
        }
    )


def test_search_uses_bounded_finance_contract_and_drops_unsafe_urls():
    captured = {}

    def handle(request):
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "ResponseMetadata": {"RequestId": "request-1"},
                "Result": {
                    "TimeCost": 123,
                    "WebResults": [
                        {
                            "Id": "result-1",
                            "SortId": 1,
                            "Title": "公司公告",
                            "SiteName": "交易所",
                            "Url": "https://example.com/announcement",
                            "Summary": "公告摘要",
                            "PublishTime": "2026-09-16T09:00:00+08:00",
                            "AuthInfoLevel": 1,
                            "AuthInfoDes": "非常权威",
                        },
                        {
                            "Id": "unsafe",
                            "SortId": 2,
                            "Title": "不安全链接",
                            "Url": "http://example.com/plaintext",
                            "Summary": "不得进入证据",
                        },
                    ],
                },
            },
        )

    client = DoubaoSearchClient(
        config=_config(search_result_limit=5),
        transport=httpx.MockTransport(handle),
    )
    result = asyncio.run(
        client.search(
            SearchRequest(
                query="平安银行 最新公告",
                scope="FINANCE",
                count=8,
                time_range="OneMonth",
            )
        )
    )

    assert captured["headers"]["authorization"] == "Bearer synthetic-search-key"
    assert captured["body"] == {
        "Query": "平安银行 最新公告",
        "SearchType": "web",
        "Count": 5,
        "Filter": {
            "NeedContent": False,
            "NeedUrl": True,
            "AuthInfoLevel": 0,
        },
        "NeedSummary": True,
        "QueryControl": {"QueryRewrite": False},
        "ContentFormats": "text",
        "TimeRange": "OneMonth",
        "Industry": "finance",
    }
    assert len(result.results) == 1
    assert result.results[0].authority_level == 1


def test_search_request_rejects_invalid_ranges_and_sites():
    with pytest.raises(ValidationError):
        SearchRequest(
            query="test",
            time_range="2026-10-01..2026-09-01",
        )
    with pytest.raises(ValidationError):
        SearchRequest(query="test", sites=["example.com/path"])


def test_search_does_not_follow_redirects_or_retry_auth_failure():
    calls = 0

    def handle(_request):
        nonlocal calls
        calls += 1
        return httpx.Response(401)

    client = DoubaoSearchClient(
        config=_config(),
        transport=httpx.MockTransport(handle),
    )
    with pytest.raises(SearchFailure, match="SEARCH_AUTH_FAILED"):
        asyncio.run(client.search(SearchRequest(query="test")))
    assert calls == 1


def test_search_maps_business_quota_error_without_exposing_message():
    client = DoubaoSearchClient(
        config=_config(),
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                json={
                    "ResponseMetadata": {
                        "Error": {
                            "Code": "10406",
                            "Message": "upstream detail must not escape",
                        }
                    }
                },
            )
        ),
    )

    with pytest.raises(SearchFailure, match="SEARCH_QUOTA_EXHAUSTED"):
        asyncio.run(client.search(SearchRequest(query="test")))
