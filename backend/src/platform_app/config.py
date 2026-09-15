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
    agent_timeout_seconds: int = Field(default=60, ge=5, le=90)
    agent_enabled: bool = False
    agent_daily_call_limit: int = Field(default=20, ge=1, le=100)
    agent_global_daily_call_limit: int = Field(default=100, ge=1, le=1000)
    cookie_secure: bool = False

    @field_validator("agent_base_url")
    @classmethod
    def secure_agent_origin(cls, value):
        from urllib.parse import urlsplit

        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Agent endpoint requires HTTPS without inline credentials")
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
