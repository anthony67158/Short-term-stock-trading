"""Actual incoming custody, independent from cash and executed orders."""
from sqlalchemy import func, select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import utcnow
from platform_app.kernel.trading import trading_date
from platform_app.modules.market.models import Instrument
from platform_app.modules.operations.models import Outbox
from platform_app.modules.portfolio.models import CustodyTransfer, PositionLot
from platform_app.modules.portfolio.openings import last_fact_time
from platform_app.modules.portfolio.service import PortfolioError, fingerprint, owned_account
from platform_app.modules.portfolio.transfer_contracts import TransferInput, TransferPage, TransferView


def record_transfer(user_id: str, account_id: str, body: TransferInput, key: str):
    with sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        existing = db.scalar(select(CustodyTransfer).where(
            CustodyTransfer.account_id == account_id, CustodyTransfer.command_key == key))
        if existing:
            if existing.request_hash != fingerprint(body):
                raise PortfolioError("IDEMPOTENCY_CONFLICT", "同一请求编号对应不同转入事实")
            return TransferView.model_validate(existing)
        if account.version != body.expected_version:
            raise PortfolioError("ACCOUNT_VERSION_CONFLICT", "账户已有变化，请刷新后核对")
        if db.scalar(select(CustodyTransfer.id).where(
            CustodyTransfer.account_id == account_id, CustodyTransfer.source_key == body.source_key)):
            raise PortfolioError("TRANSFER_SOURCE_EXISTS", "此转托管凭据已经录入")
        if body.effective_at > utcnow() or body.acquired_date > trading_date(body.effective_at):
            raise PortfolioError("TRANSFER_DATE", "取得日不能晚于转入日，转入时间不能在未来", 422)
        last = last_fact_time(db, account_id)
        if last and body.effective_at < last:
            raise PortfolioError("TRANSFER_ORDER", "转入时间不能早于已有账户事实", 422)
        if not db.get(Instrument, body.instrument_id):
            raise PortfolioError("INSTRUMENT_NOT_FOUND", "证券尚未建立档案", 422)
        quantity, basis = db.execute(select(
            func.coalesce(func.sum(PositionLot.remaining_quantity), 0),
            func.coalesce(func.sum(PositionLot.remaining_basis), 0),
        ).where(PositionLot.account_id == account_id,
                PositionLot.instrument_id == body.instrument_id)).one()
        if quantity + body.quantity_shares > 1_000_000_000 or basis + body.cost_basis >= 10**18:
            raise PortfolioError("POSITION_LIMIT", "转入后持仓数量或成本超过支持范围", 422)
        from platform_app.modules.portfolio.reconciliation import reconcile
        if not reconcile(user_id, account_id, db_session=db).matches:
            raise PortfolioError("LEDGER_MISMATCH", "账本存在差异，请先核对", 422)
        account.version += 1
        row = CustodyTransfer(
            account_id=account_id, **body.model_dump(exclude={"expected_version"}),
            account_version=account.version, command_key=key, request_hash=fingerprint(body))
        db.add(row)
        db.flush()
        db.add(PositionLot(
            id=row.id, transfer_id=row.id, account_id=account_id,
            instrument_id=row.instrument_id, acquired_date=row.acquired_date,
            remaining_quantity=row.quantity_shares, remaining_basis=row.cost_basis,
            sequence=account.version,
        ))
        db.add(Outbox(
            owner_id=user_id, event_type="portfolio.changed", aggregate_id=account_id,
            payload={"schemaVersion": "1", "accountId": account_id,
                     "aggregateVersion": account.version, "custodyTransferId": row.id},
        ))
        return TransferView.model_validate(row)


def transfer_history(user_id: str, account_id: str, before: int | None, limit: int):
    with sessions()() as db:
        owned_account(db, user_id, account_id)
        query = select(CustodyTransfer).where(CustodyTransfer.account_id == account_id)
        if before is not None:
            query = query.where(CustodyTransfer.account_version < before)
        rows = list(db.scalars(query.order_by(
            CustodyTransfer.account_version.desc()).limit(limit + 1)))
        return TransferPage(
            transfers=[TransferView.model_validate(row) for row in rows[:limit]],
            next_cursor=str(rows[limit - 1].account_version) if len(rows) > limit else None)
