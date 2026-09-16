"""Explicit private configuration; old repository .env is never implicitly loaded."""
import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", env_prefix="PLATFORM_")
    environment: Literal["local", "test", "production"] = "local"
    database_url: SecretStr = SecretStr(
        "postgresql+psycopg://platform@127.0.0.1:55432/platform"
    )
    origin: str = "http://localhost:5173"
    agent_base_url: str = "https://linlongs.com"
    agent_model: str = "gpt-5.6-terra"
    agent_api_key: SecretStr = SecretStr("")
    agent_timeout_seconds: int = Field(default=180, ge=30, le=180)
    agent_enabled: bool = False
    agent_daily_call_limit: int = Field(default=20, ge=1, le=100)
    agent_global_daily_call_limit: int = Field(default=100, ge=1, le=1000)
    agent_search_max_calls: int = Field(default=4, ge=0, le=6)
    search_enabled: bool = False
    search_base_url: str = "https://open.feedcoopapi.com/search_api/web_search"
    search_api_key: SecretStr = SecretStr("")
    search_api_key_name: str = Field(default="stock", min_length=1, max_length=80)
    search_timeout_seconds: int = Field(default=20, ge=5, le=30)
    search_result_limit: int = Field(default=8, ge=1, le=10)
    market_data_base_url: str = "https://ts.gyzcloud.top/api"
    market_data_api_key: SecretStr = SecretStr("")
    market_data_timeout_seconds: int = Field(default=40, ge=5, le=90)
    market_data_enabled: bool = False
    joint_bundle_root: Path | None = Path(
        "~/.local/share/stock-platform/joint-releases/active-shadow.json"
    ).expanduser()
    ranking_dataset_root: Path = Path(
        "~/.local/share/stock-platform/full-universe-ranking-v1"
    ).expanduser()
    market_dataset_root: Path = Path(
        "~/.local/share/stock-platform/a-share-20160101-20260915-v5"
    ).expanduser()
    ranking_model_root: Path = Path(
        "~/.local/share/stock-platform/full-universe-ranking-model-v1"
    ).expanduser()
    position_model_root: Path = Path(
        "~/.local/share/stock-platform/position-action-model-v2"
    ).expanduser()
    cookie_secure: bool = False

    @field_validator("agent_base_url")
    @classmethod
    def secure_agent_origin(cls, value):
        from urllib.parse import urlsplit

        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Agent endpoint requires HTTPS without inline credentials")
        return value

    @field_validator("market_data_base_url")
    @classmethod
    def secure_market_data_origin(cls, value):
        from urllib.parse import urlsplit

        parsed = urlsplit(value)
        allowed = {
            ("api.tushare.pro", ""),
            ("ts.gyzcloud.top", "/api"),
            ("ts2.gyzcloud.top", "/api"),
            ("tx.xiaodefa.top", "/"),
        }
        if (
            parsed.scheme != "https"
            or (parsed.hostname, parsed.path) not in allowed
            or parsed.port not in (None, 443)
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Market data endpoint is not an allowed HTTPS API")
        return value

    @field_validator("search_base_url")
    @classmethod
    def secure_search_origin(cls, value):
        if value != "https://open.feedcoopapi.com/search_api/web_search":
            raise ValueError("Search endpoint must be the approved Doubao HTTPS API")
        return value


@lru_cache
def settings() -> Settings:
    path = Path(os.environ.get(
        "PLATFORM_CONFIG_FILE",
        "~/.config/stock-platform/platform.env",
    )).expanduser()
    result = Settings(_env_file=path)
    if result.environment == "production" and (
        not result.cookie_secure or not result.origin.startswith("https://")
    ):
        raise ValueError("Production requires HTTPS and secure cookies")
    return result
