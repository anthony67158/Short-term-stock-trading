"""Settled stock dividends and splits without synthetic trades."""

from sqlalchemy import func, select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import utcnow
from platform_app.modules.market.models import Instrument
from platform_app.modules.operations.models import Outbox
from platform_app.modules.portfolio.corporate_action_contracts import (
    CorporateShareInput,
    CorporateSharePage,
    CorporateShareView,
)
from platform_app.modules.portfolio.models import (
    CorporateShareEvent,
    PositionLot,
)
from platform_app.modules.portfolio.openings import last_fact_time
from platform_app.modules.portfolio.service import (
    PortfolioError,
    fingerprint,
    owned_account,
)


def _allocate(
    lots: list[PositionLot],
    added_shares: int,
) -> list[dict]:
    total = sum(lot.remaining_quantity for lot in lots)
    if total <= 0:
        raise PortfolioError(
            "CORPORATE_POSITION_NOT_FOUND",
            "没有可承接送转股份的现有持仓",
            422,
        )
    allocations = []
    allocated = 0
    for lot in lots:
        numerator = added_shares * lot.remaining_quantity
        shares, remainder = divmod(numerator, total)
        allocations.append(
            {
                "lotId": lot.id,
                "quantityShares": shares,
                "_remainder": remainder,
            }
        )
        allocated += shares
    missing = added_shares - allocated
    for allocation in sorted(
        allocations,
        key=lambda item: (-item["_remainder"], item["lotId"]),
    )[:missing]:
        allocation["quantityShares"] += 1
    return [
        {
            "lotId": item["lotId"],
            "quantityShares": item["quantityShares"],
        }
        for item in allocations
        if item["quantityShares"] > 0
    ]


def record_share_event(
    user_id: str,
    account_id: str,
    body: CorporateShareInput,
    key: str,
) -> CorporateShareView:
    with sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        existing = db.scalar(
            select(CorporateShareEvent).where(
                CorporateShareEvent.account_id == account_id,
                CorporateShareEvent.command_key == key,
            )
        )
        if existing:
            if existing.request_hash != fingerprint(body):
                raise PortfolioError(
                    "IDEMPOTENCY_CONFLICT",
                    "同一请求编号对应不同送转股份事实",
                )
            return CorporateShareView.model_validate(existing)
        if account.version != body.expected_version:
            raise PortfolioError(
                "ACCOUNT_VERSION_CONFLICT",
                "账户已有变化，请刷新后核对",
            )
        if db.scalar(
            select(CorporateShareEvent.id).where(
                CorporateShareEvent.account_id == account_id,
                CorporateShareEvent.source_key == body.source_key,
            )
        ):
            raise PortfolioError(
                "CORPORATE_SHARE_SOURCE_EXISTS",
                "此送转股份凭据已经录入",
            )
        if body.effective_at > utcnow():
            raise PortfolioError(
                "CORPORATE_SHARE_DATE",
                "送转股份到账时间不能在未来",
                422,
            )
        last = last_fact_time(db, account_id)
        if last and body.effective_at < last:
            raise PortfolioError(
                "CORPORATE_SHARE_ORDER",
                "送转股份到账时间不能早于已有账户事实",
                422,
            )
        if not db.get(Instrument, body.instrument_id):
            raise PortfolioError(
                "INSTRUMENT_NOT_FOUND",
                "证券尚未建立档案",
                422,
            )
        from platform_app.modules.portfolio.reconciliation import reconcile

        if not reconcile(
            user_id,
            account_id,
            db_session=db,
        ).matches:
            raise PortfolioError(
                "LEDGER_MISMATCH",
                "账本存在差异，请先核对",
                422,
            )
        lots = list(
            db.scalars(
                select(PositionLot)
                .where(
                    PositionLot.account_id == account_id,
                    PositionLot.instrument_id == body.instrument_id,
                    PositionLot.remaining_quantity > 0,
                )
                .order_by(PositionLot.sequence, PositionLot.id)
                .with_for_update()
            )
        )
        current = int(
            db.scalar(
                select(
                    func.coalesce(
                        func.sum(PositionLot.remaining_quantity),
                        0,
                    )
                ).where(
                    PositionLot.account_id == account_id,
                    PositionLot.instrument_id == body.instrument_id,
                )
            )
        )
        if current + body.quantity_shares > 1_000_000_000:
            raise PortfolioError(
                "POSITION_LIMIT",
                "送转后持仓数量超过支持范围",
                422,
            )
        allocations = _allocate(lots, body.quantity_shares)
        by_id = {lot.id: lot for lot in lots}
        for allocation in allocations:
            by_id[allocation["lotId"]].remaining_quantity += (
                allocation["quantityShares"]
            )
        account.version += 1
        row = CorporateShareEvent(
            account_id=account_id,
            **body.model_dump(exclude={"expected_version"}),
            account_version=account.version,
            command_key=key,
            request_hash=fingerprint(body),
            allocations=allocations,
        )
        db.add(row)
        db.flush()
        db.add(
            Outbox(
                owner_id=user_id,
                event_type="portfolio.changed",
                aggregate_id=account_id,
                payload={
                    "schemaVersion": "1",
                    "accountId": account_id,
                    "aggregateVersion": account.version,
                    "corporateShareEventId": row.id,
                },
            )
        )
        return CorporateShareView.model_validate(row)


def share_event_history(
    user_id: str,
    account_id: str,
    before: int | None,
    limit: int,
) -> CorporateSharePage:
    with sessions()() as db:
        owned_account(db, user_id, account_id)
        query = select(CorporateShareEvent).where(
            CorporateShareEvent.account_id == account_id
        )
        if before is not None:
            query = query.where(
                CorporateShareEvent.account_version < before
            )
        rows = list(
            db.scalars(
                query.order_by(
                    CorporateShareEvent.account_version.desc()
                ).limit(limit + 1)
            )
        )
        return CorporateSharePage(
            events=[
                CorporateShareView.model_validate(row)
                for row in rows[:limit]
            ],
            next_cursor=(
                str(rows[limit - 1].account_version)
                if len(rows) > limit
                else None
            ),
        )
