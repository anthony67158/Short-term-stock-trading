from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated, Generic, TypeVar
from uuid import uuid4

from pydantic import (
    AwareDatetime, BaseModel, BeforeValidator, ConfigDict, Field,
    PlainSerializer, StringConstraints,
)
from pydantic.alias_generators import to_camel


def decimal_input(value):
    if not isinstance(value, (str, Decimal)):
        raise ValueError("金额必须使用十进制字符串")
    result = Decimal(value)
    if not result.is_finite():
        raise ValueError("金额必须是有限数")
    return result


DecimalString = Annotated[
    Decimal,
    BeforeValidator(decimal_input, json_schema_input_type=str),
    PlainSerializer(lambda value: format(value, "f"), return_type=str),
]
Money = Annotated[DecimalString, Field(max_digits=20, decimal_places=2)]
Price = Annotated[DecimalString, Field(gt=0, max_digits=18, decimal_places=4)]
Quantity = Annotated[int, Field(strict=True, ge=0, le=1_000_000_000)]
InstrumentId = Annotated[str, StringConstraints(pattern=r"^(SH|SZ|BJ)\.\d{6}$")]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid4().hex


class Contract(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, extra="forbid",
        from_attributes=True,
    )


class Meta(Contract):
    request_id: str = Field(default_factory=new_id)
    as_of: AwareDatetime = Field(default_factory=utcnow)
    revision: int | None = None


T = TypeVar("T")


class Envelope(Contract, Generic[T]):
    data: T
    meta: Meta = Field(default_factory=Meta)


class ErrorDetail(Contract):
    code: str
    message: str
    retryable: bool = False


class ErrorEnvelope(Contract):
    error: ErrorDetail
    meta: Meta = Field(default_factory=Meta)
