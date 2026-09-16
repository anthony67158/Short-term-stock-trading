from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete

from platform_app.adapters.database import sessions
from platform_app.adapters.market_public import (
    MarketError,
    normalize_universe,
    parse_quote,
)
from platform_app.contracts.base import new_id
from platform_app.modules.identity.models import User
from platform_app.modules.market import service
from platform_app.modules.market.contracts import SavedViewInput
from platform_app.modules.market.models import SavedView


def test_universe_requires_complete_unique_ordered_market_identity():
    rows = [
        {"symbol": "bj920001", "code": "920001", "name": "合成北交"},
        {"symbol": "sh688001", "code": "688001", "name": "合成科创"},
        {"symbol": "sz000001", "code": "000001", "name": "合成主板"},
        {"symbol": "sz300001", "code": "300001", "name": "合成创业"},
    ]
    result = normalize_universe(rows, 4)
    assert [row["board"] for row in result] == ["BEIJING", "STAR", "MAIN", "CHINEXT"]
    assert result[2]["id"] == "SZ.000001"
    for bad, total in [(rows, 5), (rows + rows[:1], 5), (rows[::-1], 4)]:
        with pytest.raises(ValueError):
            normalize_universe(bad, total)


def test_quote_uses_provider_timestamp_and_null_missing_price():
    fields = [""] * 35
    fields[1:6] = ["合成股票", "000001", "11.82", "11.85", "11.82"]
    fields[30], fields[33], fields[34] = "20260915150000", "11.88", "11.77"
    received = datetime(2026, 9, 15, 7, 1, tzinfo=timezone.utc)

    def raw():
        return 'v_sz000001="' + "~".join(fields) + '";\n'

    quote = parse_quote(raw(), "SZ.000001", received)
    assert quote.freshness == "RECENT"
    assert quote.execution_eligible is False
    assert quote.quoted_at.astimezone(timezone.utc).hour == 7
    assert parse_quote(raw(), "SZ.000001", received + timedelta(hours=2)).freshness == "STALE"
    fields[3] = "0"
    assert parse_quote(raw(), "SZ.000001", received).price is None
    with pytest.raises(ValueError):
        parse_quote(raw(), "SH.000001", received)
    fields[3] = "NaN"
    with pytest.raises(ValueError):
        parse_quote(raw(), "SZ.000001", received)


def test_saved_market_views_are_owner_scoped_and_idempotent():
    owner_id = new_id()
    other_id = new_id()
    with sessions().begin() as db:
        db.add_all(
            [
                User(
                    id=owner_id,
                    username="market-view-" + owner_id[:8],
                    password_hash="synthetic",
                ),
                User(
                    id=other_id,
                    username="market-view-" + other_id[:8],
                    password_hash="synthetic",
                ),
            ]
        )
    body = SavedViewInput(
        name="我的关注",
        query=" 平安 ",
        watch_only=True,
    )
    key = new_id()
    saved = service.save_view(owner_id, body, key)
    assert service.save_view(owner_id, body, key).id == saved.id
    assert saved.query == "平安"
    assert service.saved_views(owner_id).views[0].id == saved.id
    assert service.saved_views(other_id).views == []
    with pytest.raises(MarketError, match="保存视图"):
        service.delete_saved_view(other_id, saved.id)
    service.delete_saved_view(owner_id, saved.id)
    with sessions().begin() as db:
        db.execute(
            delete(SavedView).where(
                SavedView.owner_id.in_([owner_id, other_id])
            )
        )
        db.execute(
            delete(User).where(User.id.in_([owner_id, other_id]))
        )
