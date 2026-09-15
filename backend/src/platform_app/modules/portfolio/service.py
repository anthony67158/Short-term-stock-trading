import hashlib
from decimal import Decimal

from sqlalchemy import func, select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import Contract, utcnow
from platform_app.modules.identity.models import User
from platform_app.modules.operations.models import Outbox
from platform_app.modules.portfolio.contracts import (
    AccountBalance, AccountInput, AccountView, CashEntryView, CashFlowInput, CashPage,
)
from platform_app.modules.portfolio.models import Account, CashEntry


class PortfolioError(ValueError):
    def __init__(self, code: str, message: str, status: int = 409):
        self.code, self.message, self.status = code, message, status


def fingerprint(body: Contract) -> str:
    return hashlib.sha256(body.model_dump_json().encode()).hexdigest()


def owned_account(db, user_id: str, account_id: str, *, lock: bool = False) -> Account:
    query = select(Account).where(Account.id == account_id, Account.owner_id == user_id)
    account = db.scalar(query.with_for_update() if lock else query)
    if not account:
        raise PortfolioError("ACCOUNT_NOT_FOUND", "账户不存在或无权访问", 404)
    return account


def create_account(user_id: str, body: AccountInput, key: str) -> AccountView:
    with sessions().begin() as db:
        db.scalar(select(User).where(User.id == user_id).with_for_update())
        existing = db.scalar(select(Account).where(
            Account.owner_id == user_id, Account.creation_key == key,
        ))
        if existing:
            if existing.creation_hash != fingerprint(body):
                raise PortfolioError("IDEMPOTENCY_CONFLICT", "同一请求编号的内容发生变化")
            return AccountView.model_validate(existing.creation_result)
        account = Account(
            owner_id=user_id, **body.model_dump(), creation_key=key,
            creation_hash=fingerprint(body),
        )
        db.add(account)
        db.flush()
        view = AccountView.model_validate(account)
        account.creation_result = view.model_dump(mode="json")
        return view


def list_accounts(user_id: str, after: str | None, limit: int) -> list[AccountView]:
    with sessions()() as db:
        query = select(Account).where(Account.owner_id == user_id)
        if after:
            query = query.where(Account.id > after)
        return [AccountView.model_validate(row) for row in db.scalars(
            query.order_by(Account.id).limit(limit),
        )]


def cash_total(db, account_id: str) -> Decimal:
    return db.scalar(select(func.coalesce(func.sum(CashEntry.amount), 0)).where(
        CashEntry.account_id == account_id,
    ))


def balance(user_id: str, account_id: str) -> AccountBalance:
    with sessions().begin() as db:
        # Account lock keeps the version and cash total from different commits apart.
        account = owned_account(db, user_id, account_id, lock=True)
        return AccountBalance(
            account=AccountView.model_validate(account), cash_balance=cash_total(db, account_id),
        )


def record_cash(user_id: str, account_id: str, body: CashFlowInput, key: str) -> CashEntryView:
    with sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        existing = db.scalar(select(CashEntry).where(
            CashEntry.account_id == account_id, CashEntry.source_key == key,
            CashEntry.kind.in_(["OPENING", "DEPOSIT", "WITHDRAWAL"]),
        ))
        if existing:
            if existing.request_hash != fingerprint(body):
                raise PortfolioError("IDEMPOTENCY_CONFLICT", "同一请求编号的内容发生变化")
            return CashEntryView.model_validate(existing)
        if account.version != body.expected_version:
            raise PortfolioError("ACCOUNT_VERSION_CONFLICT", "账户已有新记录，请刷新后核对")
        if body.effective_at > utcnow():
            raise PortfolioError("FUTURE_CASH_FLOW", "不能将尚未发生的资金变动记为事实", 422)
        last = db.scalar(select(CashEntry).where(
            CashEntry.account_id == account_id, CashEntry.kind != "REVERSAL")
                         .order_by(CashEntry.account_version.desc()).limit(1))
        if body.kind == "OPENING" and last:
            raise PortfolioError("OPENING_ALREADY_STARTED", "期初余额只能作为账户首笔资金记录")
        if last and body.effective_at < last.effective_at:
            raise PortfolioError("OUT_OF_ORDER_CASH_FLOW", "请按发生时间顺序录入资金记录", 422)
        amount = -body.amount if body.kind == "WITHDRAWAL" else body.amount
        total = cash_total(db, account_id) + amount
        if total < 0:
            raise PortfolioError("INSUFFICIENT_CASH", "出金金额超过现金余额", 422)
        if total >= Decimal("1000000000000000000"):
            raise PortfolioError("BALANCE_LIMIT", "余额超过当前账户支持的金额范围", 422)
        account.version += 1
        entry = CashEntry(
            account_id=account_id, source_key=key, request_hash=fingerprint(body),
            kind=body.kind, amount=amount, source=body.source, effective_at=body.effective_at,
            account_version=account.version,
        )
        db.add(entry)
        db.flush()
        db.add(Outbox(
            owner_id=user_id, event_type="portfolio.changed", aggregate_id=account_id,
            payload={"schemaVersion": "1", "accountId": account_id,
                     "aggregateVersion": account.version, "cashEntryId": entry.id},
        ))
        return CashEntryView.model_validate(entry)


def cash_history(user_id: str, account_id: str, before: int | None, limit: int) -> CashPage:
    with sessions()() as db:
        owned_account(db, user_id, account_id)
        query = select(CashEntry).where(CashEntry.account_id == account_id)
        if before is not None:
            query = query.where(CashEntry.account_version < before)
        rows = list(db.scalars(query.order_by(CashEntry.account_version.desc()).limit(limit + 1)))
        return CashPage(
            entries=[CashEntryView.model_validate(row) for row in rows[:limit]],
            next_cursor=str(rows[limit - 1].account_version) if len(rows) > limit else None,
        )
