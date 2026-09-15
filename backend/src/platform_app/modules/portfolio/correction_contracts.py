from pydantic import AwareDatetime, Field

from platform_app.contracts.base import Contract, Money


class CorrectionInput(Contract):
    reason: str = Field(min_length=1, max_length=500, pattern=r"\S")
    expected_version: int = Field(strict=True, ge=1)


class CorrectionCommit(CorrectionInput):
    preview_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class CorrectionPreview(Contract):
    execution_id: str
    account_version: int
    cash_before: Money
    cash_after: Money
    reversal_amount: Money
    open_shares_before: int
    open_shares_after: int
    recalculated_sales: int
    preview_hash: str


class CorrectionView(Contract):
    id: str
    execution_id: str
    reason: str
    actor_id: str
    recorded_at: AwareDatetime
    account_version: int
    reversal_amount: Money


class CorrectionPage(Contract):
    corrections: list[CorrectionView]
    next_cursor: str | None
