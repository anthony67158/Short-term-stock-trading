from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Header, Query
from pydantic import AwareDatetime

from platform_app.adapters.market_public import fetch_quote
from platform_app.contracts.base import Envelope, InstrumentId
from platform_app.kernel.calendar import CalendarDay, calendar_day
from platform_app.modules.identity.routes import CurrentUser
from platform_app.modules.market import service
from platform_app.modules.market.contracts import (
    InstrumentPage,
    InstrumentView,
    QuoteView,
    SavedViewInput,
    SavedViewPage,
    SavedViewView,
    WatchInput,
    WatchPage,
)

router = APIRouter(prefix="/api/v1", tags=["market"])
Limit = Annotated[int, Query(ge=1, le=100)]
CommandKey = Annotated[
    str,
    Header(alias="Idempotency-Key", min_length=8, max_length=128),
]


@router.get("/market/calendar", response_model=Envelope[CalendarDay])
def get_calendar(
    user: CurrentUser, exchange: Literal["SH", "SZ", "BJ"], day: date,
    as_of: Annotated[AwareDatetime | None, Query(alias="asOf")] = None,
):
    return Envelope(data=calendar_day(exchange, day, as_of=as_of))


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


@router.post(
    "/market/saved-views",
    response_model=Envelope[SavedViewView],
    status_code=201,
)
def create_saved_view(
    body: SavedViewInput,
    user: CurrentUser,
    key: CommandKey,
):
    return Envelope(data=service.save_view(user.id, body, key))


@router.get(
    "/market/saved-views",
    response_model=Envelope[SavedViewPage],
)
def list_saved_views(user: CurrentUser):
    return Envelope(data=service.saved_views(user.id))


@router.delete(
    "/market/saved-views/{view_id}",
    status_code=204,
)
def delete_saved_view(view_id: str, user: CurrentUser):
    service.delete_saved_view(user.id, view_id)
