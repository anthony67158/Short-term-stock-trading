from typing import Literal

from platform_app.contracts.base import Contract
from platform_app.modules.portfolio.opening_contracts import OpeningInput, OpeningView


class TransferInput(OpeningInput):
    """Original acquisition/cost facts for an actual incoming custody transfer."""


class TransferView(OpeningView):
    direction: Literal["IN"] = "IN"


class TransferPage(Contract):
    transfers: list[TransferView]
    next_cursor: str | None
