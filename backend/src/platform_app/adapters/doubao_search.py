"""Bounded Doubao Search transport for untrusted research discovery."""

import json
import re
from datetime import date
from typing import Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator

from platform_app.config import Settings, settings

SEARCH_ENDPOINT = "https://open.feedcoopapi.com/search_api/web_search"
MAX_RESPONSE_BYTES = 1_000_000
MAX_EVIDENCE_TEXT = 2_000
TIME_RANGE_SHORTCUTS = {"OneDay", "OneWeek", "OneMonth", "OneYear"}
DATE_RANGE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$")


class SearchFailure(ValueError):
    pass


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    query: str = Field(min_length=1, max_length=100)
    scope: Literal["FINANCE", "OFFICIAL", "NEWS"] = "FINANCE"
    count: int = Field(default=5, ge=1, le=10)
    time_range: str | None = None
    sites: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("time_range")
    @classmethod
    def valid_time_range(cls, value):
        if value is None or value in TIME_RANGE_SHORTCUTS:
            return value
        match = DATE_RANGE.fullmatch(value)
        if not match:
            raise ValueError("SEARCH_TIME_RANGE_INVALID")
        start, end = (date.fromisoformat(item) for item in match.groups())
        if start > end:
            raise ValueError("SEARCH_TIME_RANGE_INVALID")
        return value

    @field_validator("sites")
    @classmethod
    def valid_sites(cls, values):
        for value in values:
            parsed = urlsplit(f"https://{value}")
            if (
                not parsed.hostname
                or parsed.hostname != value
                or parsed.port is not None
                or parsed.username
                or parsed.password
            ):
                raise ValueError("SEARCH_SITE_INVALID")
        return values


class SearchEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider_id: str
    rank: int
    title: str
    site_name: str | None
    url: str
    text: str
    published_at: str | None
    authority_level: int | None
    authority_description: str | None


class SearchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str
    scope: Literal["FINANCE", "OFFICIAL", "NEWS"]
    request_id: str
    elapsed_ms: int
    results: list[SearchEvidence]


def _safe_https_url(value) -> str | None:
    parsed = urlsplit(str(value or ""))
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
    ):
        return None
    return parsed.geturl()


def _bounded_text(value, limit: int) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


class DoubaoSearchClient:
    def __init__(
        self,
        *,
        config: Settings | None = None,
        transport=None,
    ):
        self.config = config or settings()
        if (
            not self.config.search_enabled
            or not self.config.search_api_key.get_secret_value()
        ):
            raise SearchFailure("SEARCH_UNAVAILABLE")
        if self.config.search_base_url != SEARCH_ENDPOINT:
            raise SearchFailure("SEARCH_ENDPOINT_REJECTED")
        self.transport = transport

    async def search(self, request: SearchRequest) -> SearchResponse:
        count = min(request.count, self.config.search_result_limit)
        filters = {
            "NeedContent": False,
            "NeedUrl": True,
            "AuthInfoLevel": 1 if request.scope == "OFFICIAL" else 0,
        }
        if request.sites:
            filters["Sites"] = "|".join(request.sites)
        body = {
            "Query": request.query,
            "SearchType": "web",
            "Count": count,
            "Filter": filters,
            "NeedSummary": True,
            "QueryControl": {"QueryRewrite": False},
            "ContentFormats": "text",
        }
        if request.time_range:
            body["TimeRange"] = request.time_range
        if request.scope in {"FINANCE", "OFFICIAL"}:
            body["Industry"] = "finance" if request.scope == "FINANCE" else "gov"
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(
                    self.config.search_timeout_seconds,
                    connect=min(5, self.config.search_timeout_seconds),
                ),
                follow_redirects=False,
                transport=self.transport,
            ) as client:
                async with client.stream(
                    "POST",
                    SEARCH_ENDPOINT,
                    headers={
                        "Authorization": (
                            "Bearer "
                            + self.config.search_api_key.get_secret_value()
                        ),
                        "Content-Type": "application/json",
                        "X-Traffic-Tag": "stock_platform_agent",
                    },
                    json=body,
                ) as response:
                    if response.status_code in (401, 403):
                        raise SearchFailure("SEARCH_AUTH_FAILED")
                    if response.status_code == 429:
                        raise SearchFailure("SEARCH_RATE_LIMITED")
                    response.raise_for_status()
                    chunks = bytearray()
                    async for chunk in response.aiter_bytes():
                        chunks.extend(chunk)
                        if len(chunks) > MAX_RESPONSE_BYTES:
                            raise SearchFailure("SEARCH_RESPONSE_TOO_LARGE")
            payload = json.loads(chunks)
        except SearchFailure:
            raise
        except httpx.TimeoutException as exc:
            raise SearchFailure("SEARCH_TIMEOUT") from exc
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise SearchFailure("SEARCH_UPSTREAM_FAILED") from exc

        metadata = payload.get("ResponseMetadata") or {}
        if metadata.get("Error"):
            code = str(metadata["Error"].get("Code") or "")
            mapped = {
                "10403": "SEARCH_AUTH_FAILED",
                "10406": "SEARCH_QUOTA_EXHAUSTED",
                "10407": "SEARCH_QUOTA_UNAVAILABLE",
                "10408": "SEARCH_ACCOUNT_ARREARS",
                "10412": "SEARCH_QUOTA_EXHAUSTED",
                "10500": "SEARCH_UPSTREAM_FAILED",
                "700429": "SEARCH_RATE_LIMITED",
            }
            raise SearchFailure(mapped.get(code, "SEARCH_API_FAILED"))
        result = payload.get("Result")
        if not isinstance(result, dict):
            raise SearchFailure("SEARCH_RESPONSE_INVALID")
        evidence = []
        for raw in result.get("WebResults") or []:
            if not isinstance(raw, dict):
                raise SearchFailure("SEARCH_RESPONSE_INVALID")
            url = _safe_https_url(raw.get("Url"))
            text = _bounded_text(raw.get("Summary") or raw.get("Snippet"), MAX_EVIDENCE_TEXT)
            title = _bounded_text(raw.get("Title"), 300)
            if not url or not text or not title:
                continue
            evidence.append(
                SearchEvidence(
                    provider_id=_bounded_text(raw.get("Id"), 160),
                    rank=int(raw.get("SortId") or len(evidence) + 1),
                    title=title,
                    site_name=_bounded_text(raw.get("SiteName"), 120) or None,
                    url=url,
                    text=text,
                    published_at=_bounded_text(raw.get("PublishTime"), 80) or None,
                    authority_level=(
                        int(raw["AuthInfoLevel"])
                        if raw.get("AuthInfoLevel") is not None
                        else None
                    ),
                    authority_description=(
                        _bounded_text(raw.get("AuthInfoDes"), 80) or None
                    ),
                )
            )
        return SearchResponse(
            query=request.query,
            scope=request.scope,
            request_id=_bounded_text(metadata.get("RequestId"), 160),
            elapsed_ms=int(result.get("TimeCost") or 0),
            results=evidence[:count],
        )
