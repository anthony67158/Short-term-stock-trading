import asyncio

from platform_app.adapters.doubao_search import SearchEvidence, SearchResponse
from platform_app.entrypoints.doubao_search_mcp import (
    StockSearchInput,
    _execute,
    mcp,
)


class _SearchClient:
    async def search(self, request):
        return SearchResponse(
            query=request.query,
            scope=request.scope,
            request_id="request-1",
            elapsed_ms=10,
            results=[
                SearchEvidence(
                    provider_id="result-1",
                    rank=1,
                    title="合成公告",
                    site_name="交易所",
                    url="https://example.com/announcement",
                    text="合成公告摘要",
                    published_at="2026-09-16T09:00:00+08:00",
                    authority_level=1,
                    authority_description="非常权威",
                )
            ],
        )


def test_mcp_exposes_three_read_only_search_tools():
    tools = asyncio.run(mcp.list_tools())
    names = {tool.name for tool in tools}

    assert names == {
        "stock_search_finance",
        "stock_search_official",
        "stock_search_news",
    }
    assert all(tool.annotations.readOnlyHint for tool in tools)
    assert all(not tool.annotations.destructiveHint for tool in tools)


def test_mcp_search_returns_structured_untrusted_results():
    result = asyncio.run(
        _execute(
            StockSearchInput(query="合成公司公告", count=2),
            "OFFICIAL",
            client=_SearchClient(),
        )
    )

    assert result.provider == "DOUBAO_SEARCH"
    assert result.trust == "UNTRUSTED_DISCOVERY"
    assert result.results[0]["authorityLevel"] == 1
