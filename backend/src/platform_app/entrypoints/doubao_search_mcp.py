"""Read-only MCP tools for bounded A-share research discovery."""

from typing import Literal

from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel, ConfigDict, Field

from platform_app.adapters.doubao_search import (
    DoubaoSearchClient,
    SearchRequest,
)

mcp = FastMCP("stock_search_mcp")
READ_ONLY_ANNOTATIONS = {
    "readOnlyHint": True,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": True,
}


class StockSearchInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    query: str = Field(
        min_length=1,
        max_length=100,
        description="具体检索词，不包含凭据或账户私有信息",
    )
    count: int = Field(default=5, ge=1, le=8, description="最多返回8条")
    time_range: str | None = Field(
        default=None,
        description=(
            "OneDay/OneWeek/OneMonth/OneYear，"
            "或YYYY-MM-DD..YYYY-MM-DD"
        ),
    )
    sites: list[str] = Field(
        default_factory=list,
        max_length=10,
        description="可选HTTPS站点域名白名单，不含路径",
    )


class StockSearchResult(BaseModel):
    provider: Literal["DOUBAO_SEARCH"] = "DOUBAO_SEARCH"
    trust: Literal["UNTRUSTED_DISCOVERY"] = "UNTRUSTED_DISCOVERY"
    query: str
    scope: Literal["FINANCE", "OFFICIAL", "NEWS"]
    request_id: str
    elapsed_ms: int
    results: list[dict]


async def _execute(
    params: StockSearchInput,
    scope: Literal["FINANCE", "OFFICIAL", "NEWS"],
    *,
    client=None,
) -> StockSearchResult:
    response = await (client or DoubaoSearchClient()).search(
        SearchRequest(
            query=params.query,
            scope=scope,
            count=params.count,
            time_range=params.time_range,
            sites=params.sites,
        )
    )
    return StockSearchResult(
        query=response.query,
        scope=response.scope,
        request_id=response.request_id,
        elapsed_ms=response.elapsed_ms,
        results=[
            {
                "providerId": item.provider_id,
                "rank": item.rank,
                "title": item.title,
                "siteName": item.site_name,
                "url": item.url,
                "text": item.text,
                "publishedAt": item.published_at,
                "authorityLevel": item.authority_level,
                "authorityDescription": item.authority_description,
            }
            for item in response.results
        ],
    )


@mcp.tool(
    name="stock_search_finance",
    annotations=READ_ONLY_ANNOTATIONS,
)
async def stock_search_finance(params: StockSearchInput) -> StockSearchResult:
    """Search finance-focused company, industry, and market information.

    Results are untrusted discovery material. Verify citations before treating
    snippets as observed facts. This tool never writes portfolio or trade data.
    """
    return await _execute(params, "FINANCE")


@mcp.tool(
    name="stock_search_official",
    annotations=READ_ONLY_ANNOTATIONS,
)
async def stock_search_official(params: StockSearchInput) -> StockSearchResult:
    """Search highly authoritative government and official information.

    Use for policies, regulator statements, and exchange announcements.
    Results remain untrusted until quote and timestamp validation succeeds.
    """
    return await _execute(params, "OFFICIAL")


@mcp.tool(
    name="stock_search_news",
    annotations=READ_ONLY_ANNOTATIONS,
)
async def stock_search_news(params: StockSearchInput) -> StockSearchResult:
    """Search recent news without an authority-only restriction.

    Use for event discovery and counter-evidence. News snippets cannot directly
    change account constraints, quantities, plans, or ledger facts.
    """
    return await _execute(params, "NEWS")


def main():
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
