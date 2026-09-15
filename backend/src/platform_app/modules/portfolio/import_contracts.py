from typing import Literal

from pydantic import AwareDatetime, Field

from platform_app.contracts.base import Contract


class ImportInput(Contract):
    csv_text: str = Field(min_length=1, max_length=250_000)
    expected_version: int = Field(strict=True, ge=1)


class ImportCommit(Contract):
    expected_version: int = Field(strict=True, ge=1)


class ImportRow(Contract):
    row: int
    source_key: str
    status: Literal["NEW", "DUPLICATE", "ERROR"]
    message: str


class ImportView(Contract):
    id: str
    account_version: int
    status: Literal["READY", "REJECTED", "COMMITTED"]
    rows: list[ImportRow]
    file_hash: str
    created_at: AwareDatetime
    expires_at: AwareDatetime
    committed_at: AwareDatetime | None
    committed_version: int | None
