from typing import Annotated

from fastapi import APIRouter, Query

from platform_app.adapters.market_public import fetch_quote
from platform_app.contracts.base import Envelope, InstrumentId
from platform_app.modules.identity.routes import CurrentUser
from platform_app.modules.market import service
from platform_app.modules.market.contracts import (
    InstrumentPage, InstrumentView, QuoteView, WatchInput, WatchPage,
)

router = APIRouter(prefix="/api/v1", tags=["market"])
Limit = Annotated[int, Query(ge=1, le=100)]


@router.get("/instruments", response_model=Envelope[InstrumentPage])
def list_instruments(
    user: CurrentUser, query: Annotated[str, Query(max_length=80)] = "",
    cursor: InstrumentId | None = None, limit: Limit = 50,
):
    return Envelope(data=service.instruments(query.strip(), cursor, limit))


@router.get("/instruments/{instrument_id}", response_model=Envelope[InstrumentView])
def get_instrument(instrument_id: InstrumentId, user: CurrentUser):
    return Envelope(data=service.instrument(instrument_id))


@router.get("/instruments/{instrument_id}/quotes", response_model=Envelope[QuoteView])
def get_quote(instrument_id: InstrumentId, user: CurrentUser):
    service.instrument(instrument_id)
    return Envelope(data=fetch_quote(instrument_id))


@router.get("/watchlists", response_model=Envelope[WatchPage])
def get_watches(user: CurrentUser, cursor: InstrumentId | None = None, limit: Limit = 50):
    return Envelope(data=service.watches(user.id, cursor, limit))


@router.post("/watchlists", status_code=204)
def add_watch(body: WatchInput, user: CurrentUser):
    service.set_watch(user.id, body.instrument_id, True)


@router.delete("/watchlists/{instrument_id}", status_code=204)
def remove_watch(instrument_id: InstrumentId, user: CurrentUser):
    service.set_watch(user.id, instrument_id, False)
