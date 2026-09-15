from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, model_validator

from platform_app.contracts.base import Contract, InstrumentId, Money

IdempotencyKey = Annotated[str, Field(min_length=8, max_length=128)]


class AccountInput(Contract):
    name: str = Field(min_length=1, max_length=80, pattern=r"\S")
    kind: Literal["REAL", "SIMULATED"]
    currency: Literal["CNY"] = "CNY"
    max_position_percent: int = Field(strict=True, ge=1, le=100)


class AccountView(AccountInput):
    id: str
    version: int
    created_at: AwareDatetime


class CashFlowInput(Contract):
    kind: Literal["OPENING", "DEPOSIT", "WITHDRAWAL", "CASH_DIVIDEND", "DIVIDEND_TAX"]
    amount: Annotated[Money, Field(gt=0)]
    effective_at: AwareDatetime
    source: str = Field(min_length=1, max_length=300, pattern=r"\S")
    expected_version: int = Field(strict=True, ge=1)
    instrument_id: InstrumentId | None = None
    corporate_source_key: str | None = Field(default=None, min_length=1, max_length=128, pattern=r"\S")

    @model_validator(mode="after")
    def corporate_reference(self):
        corporate = self.kind in ("CASH_DIVIDEND", "DIVIDEND_TAX")
        if corporate != (self.instrument_id is not None) or corporate != (
                self.corporate_source_key is not None):
            raise ValueError("分红与补税必须关联证券及凭据编号，其他资金类型不得带公司行动字段")
        return self


class CashEntryView(Contract):
    id: str
    kind: Literal[
        "OPENING", "DEPOSIT", "WITHDRAWAL", "EXECUTION", "REVERSAL", "CASH_DIVIDEND", "DIVIDEND_TAX",
    ]
    amount: Money
    effective_at: AwareDatetime
    recorded_at: AwareDatetime
    source: str
    account_version: int
    execution_id: str | None = None
    correction_id: str | None = None
    instrument_id: InstrumentId | None = None
    corporate_source_key: str | None = None


class CashPage(Contract):
    entries: list[CashEntryView]
    next_cursor: str | None


class AccountBalance(Contract):
    account: AccountView
    cash_balance: Money
