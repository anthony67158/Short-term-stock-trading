import hashlib

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert

from platform_app.adapters.database import sessions
from platform_app.adapters.market_public import MarketError, SINA, canonical, download_universe
from platform_app.contracts.base import utcnow
from platform_app.modules.market.contracts import (
    InstrumentPage, InstrumentView, UniverseView, WatchPage,
)
from platform_app.modules.market.models import Instrument, UniverseSnapshot, Watch


def sync_universe() -> UniverseView:
    # Only one importer; separate advisory-lock connection, no long-lived write transaction.
    from platform_app.adapters.database import engine

    with engine().connect().execution_options(isolation_level="AUTOCOMMIT") as guard:
        acquired = guard.scalar(select(func.pg_try_advisory_lock(618051017)))
        if not acquired:
            raise MarketError("SYNC_RUNNING", "证券目录正在同步", 409)
        try:
            rows = download_universe()
            return publish_universe(rows)
        finally:
            guard.execute(select(func.pg_advisory_unlock(618051017)))


def publish_universe(rows: list[dict]) -> UniverseView:
    now = utcnow()
    digest = hashlib.sha256(canonical(rows).encode()).hexdigest()
    with sessions().begin() as db:
        db.execute(update(Instrument).values(is_current=False))
        for offset in range(0, len(rows), 500):
            query = insert(Instrument).values([
                dict(row, first_seen_at=now, last_seen_at=now, is_current=True)
                for row in rows[offset:offset + 500]
            ])
            db.execute(query.on_conflict_do_update(
                index_elements=[Instrument.id],
                set_={"name": query.excluded.name, "board": query.excluded.board,
                      "last_seen_at": now, "is_current": True},
            ))
        snapshot = UniverseSnapshot(
            source="新浪财经", source_url=SINA, count=len(rows), content_hash=digest,
            members=rows, acquired_at=now,
        )
        db.add(snapshot)
        db.flush()
        return UniverseView.model_validate(snapshot)


def instruments(query: str, cursor: str | None, limit: int) -> InstrumentPage:
    with sessions()() as db:
        sql = select(Instrument).where(Instrument.is_current)
        if query:
            sql = sql.where(or_(
                Instrument.code.contains(query, autoescape=True),
                Instrument.name.contains(query, autoescape=True),
                Instrument.id == query.upper(),
            ))
        if cursor:
            sql = sql.where(Instrument.id > cursor)
        rows = list(db.scalars(sql.order_by(Instrument.id).limit(limit + 1)))
        snapshot = db.scalar(select(UniverseSnapshot).order_by(
            UniverseSnapshot.acquired_at.desc(),
        ).limit(1))
        return InstrumentPage(
            instruments=[InstrumentView.model_validate(row) for row in rows[:limit]],
            next_cursor=rows[limit - 1].id if len(rows) > limit else None,
            universe=UniverseView.model_validate(snapshot) if snapshot else None,
        )


def instrument(instrument_id: str) -> InstrumentView:
    with sessions()() as db:
        row = db.get(Instrument, instrument_id)
        if not row:
            raise MarketError("INSTRUMENT_NOT_FOUND", "证券未收录，请核对市场和代码", 404)
        return InstrumentView.model_validate(row)


def set_watch(user_id: str, instrument_id: str, enabled: bool):
    instrument(instrument_id)
    with sessions().begin() as db:
        if enabled:
            db.execute(insert(Watch).values(
                owner_id=user_id, instrument_id=instrument_id,
            ).on_conflict_do_nothing())
        else:
            db.execute(delete(Watch).where(
                Watch.owner_id == user_id, Watch.instrument_id == instrument_id,
            ))


def watches(user_id: str, cursor: str | None, limit: int) -> WatchPage:
    with sessions()() as db:
        query = select(Instrument).join(Watch).where(Watch.owner_id == user_id)
        if cursor:
            query = query.where(Instrument.id > cursor)
        rows = list(db.scalars(query.order_by(Instrument.id).limit(limit + 1)))
        return WatchPage(
            instruments=[InstrumentView.model_validate(row) for row in rows[:limit]],
            next_cursor=rows[limit - 1].id if len(rows) > limit else None,
        )
