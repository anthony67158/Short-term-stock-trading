from typing import Annotated

from pydantic import AwareDatetime, Field

from platform_app.contracts.base import Contract, Money, Price, Quantity
from platform_app.modules.portfolio.execution_contracts import ActualFees


class ReplacementFact(Contract):
    quantity_shares: Annotated[Quantity, Field(gt=0)]
    price: Price
    fees: ActualFees


class CorrectionInput(Contract):
    reason: str = Field(min_length=1, max_length=500, pattern=r"\S")
    expected_version: int = Field(strict=True, ge=1)
    replacement: ReplacementFact | None = None


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
    replacement: ReplacementFact | None = None


class CorrectionView(Contract):
    id: str
    execution_id: str
    reason: str
    actor_id: str
    recorded_at: AwareDatetime
    account_version: int
    reversal_amount: Money
    replacement: ReplacementFact | None = None


class CorrectionPage(Contract):
    corrections: list[CorrectionView]
    next_cursor: str | None
