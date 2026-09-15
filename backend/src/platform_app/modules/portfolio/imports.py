"""Bounded CSV previews run the real writer inside a rolled-back savepoint."""
import csv
import hashlib
import io
from datetime import timedelta

from pydantic import ValidationError
from sqlalchemy import select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.portfolio.execution_contracts import ExecutionInput
from platform_app.modules.portfolio.executions import record_execution
from platform_app.modules.portfolio.import_contracts import ImportCommit, ImportInput, ImportRow, ImportView
from platform_app.modules.portfolio.models import ExecutionImport
from platform_app.modules.portfolio.reconciliation import reconcile
from platform_app.modules.portfolio.service import PortfolioError, fingerprint, owned_account

HEADERS = (
    "instrumentId", "sourceKey", "side", "quantityShares", "price", "executedAt",
    "commission", "stampTax", "transferFee", "otherFee", "source",
)


def parse_csv(text: str):
    try:
        reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")), strict=True)
        if reader.fieldnames is None or sorted(reader.fieldnames) != sorted(HEADERS):
            raise PortfolioError("IMPORT_HEADERS", "CSV列名必须与交割模板一致，且不能重复", 422)
        rows = []
        for index, row in enumerate(reader, start=1):
            if index > 500:
                raise PortfolioError("IMPORT_LIMIT", "单次最多导入500笔成交，请按时间拆分", 422)
            rows.append(row)
        if not rows:
            raise PortfolioError("IMPORT_EMPTY", "CSV没有成交记录", 422)
        return rows
    except (csv.Error, UnicodeError) as exc:
        raise PortfolioError("IMPORT_FORMAT", "CSV格式无效，请使用UTF-8模板", 422) from exc


def parse_fact(raw, version):
    if any(value is None for value in raw.values()) or None in raw:
        raise ValueError("列数不一致")
    data = {key: value.strip() for key, value in raw.items()}
    shares = data["quantityShares"]
    if not shares.isascii() or not shares.isdigit():
        raise ValueError("股数必须为整数")
    data["quantityShares"] = int(shares)
    data["fees"] = {key: data.pop(key) for key in
                    ("commission", "stampTax", "transferFee", "otherFee")}
    data["expectedVersion"] = version
    return ExecutionInput.model_validate(data)


def preview_import(user_id: str, account_id: str, body: ImportInput, key: str):
    with sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        existing = db.scalar(select(ExecutionImport).where(
            ExecutionImport.account_id == account_id, ExecutionImport.command_key == key))
        if existing:
            if existing.request_hash != fingerprint(body):
                raise PortfolioError("IDEMPOTENCY_CONFLICT", "同一请求编号对应不同导入文件")
            return ImportView.model_validate(existing.creation_result)
        if account.version != body.expected_version:
            raise PortfolioError("ACCOUNT_VERSION_CONFLICT", "账户已有新记录，请刷新后重新预览")
        if not reconcile(user_id, account_id, db_session=db).matches:
            raise PortfolioError("LEDGER_MISMATCH", "账本存在核对差异，请先处理差异", 422)
        raw_rows = parse_csv(body.csv_text)
        file_hash = hashlib.sha256(body.csv_text.encode()).hexdigest()
        preview_id = new_id()
        facts, reports = [], []
        # No preview writes may survive, including command receipts and outbox events.
        savepoint = db.begin_nested()
        try:
            for index, raw in enumerate(raw_rows, start=1):
                reference = str(raw.get("sourceKey") or "")[:128]
                try:
                    fact = parse_fact(raw, account.version)
                except (ValidationError, ValueError):
                    reports.append(ImportRow(row=index, source_key=reference, status="ERROR",
                                             message="字段不完整或格式无效，请核对数量、价格、费用和带时区时间"))
                    continue
                try:
                    previous = account.version
                    record_execution(user_id, account_id, fact,
                                     f"import:{preview_id}:{index}", db_session=db)
                    duplicate = account.version == previous
                    facts.append(fact.model_dump(mode="json"))
                    reports.append(ImportRow(row=index, source_key=reference,
                                             status="DUPLICATE" if duplicate else "NEW",
                                             message="已存在相同成交，将跳过" if duplicate else "校验通过，待确认入账"))
                except PortfolioError as exc:
                    reports.append(ImportRow(row=index, source_key=reference,
                                             status="ERROR", message=exc.message))
        finally:
            savepoint.rollback()
        preview = ExecutionImport(
            id=preview_id, account_id=account_id, account_version=body.expected_version,
            status="REJECTED" if any(row.status == "ERROR" for row in reports) else "READY",
            command_key=key, request_hash=fingerprint(body), file_hash=file_hash,
            facts=facts, rows=[row.model_dump(mode="json") for row in reports],
            expires_at=utcnow() + timedelta(minutes=15), creation_result={},
        )
        db.add(preview)
        db.flush()
        view = ImportView.model_validate(preview)
        preview.creation_result = view.model_dump(mode="json")
        return view


def owned_import(db, account_id, import_id):
    preview = db.get(ExecutionImport, import_id)
    if not preview or preview.account_id != account_id:
        raise PortfolioError("IMPORT_NOT_FOUND", "导入预览不存在或无权访问", 404)
    return preview


def get_import(user_id: str, account_id: str, import_id: str):
    with sessions()() as db:
        owned_account(db, user_id, account_id)
        return ImportView.model_validate(owned_import(db, account_id, import_id))


def commit_import(user_id: str, account_id: str, import_id: str, body: ImportCommit):
    # The immutable preview id is the permanent business idempotency key for confirmation.
    with sessions().begin() as db:
        account = owned_account(db, user_id, account_id, lock=True)
        preview = owned_import(db, account_id, import_id)
        if body.expected_version != preview.account_version:
            raise PortfolioError("IMPORT_VERSION_CONFLICT", "确认版本与预览不一致")
        if preview.status == "COMMITTED":
            return ImportView.model_validate(preview)
        if preview.status != "READY":
            raise PortfolioError("IMPORT_REJECTED", "预览中存在错误，请修正文件后重新预览", 422)
        if preview.expires_at <= utcnow():
            raise PortfolioError("IMPORT_EXPIRED", "导入预览已过期，请重新预览", 422)
        if account.version != preview.account_version:
            raise PortfolioError("ACCOUNT_VERSION_CONFLICT", "账户已有新记录，请重新预览文件")
        if not reconcile(user_id, account_id, db_session=db).matches:
            raise PortfolioError("LEDGER_MISMATCH", "账本存在核对差异，请先处理差异", 422)
        for index, raw in enumerate(preview.facts, start=1):
            fact = ExecutionInput.model_validate(raw).model_copy(
                update={"expected_version": account.version})
            record_execution(user_id, account_id, fact,
                             f"import:{preview.id}:{index}", db_session=db)
        preview.status = "COMMITTED"
        preview.committed_at, preview.committed_version = utcnow(), account.version
        return ImportView.model_validate(preview)
