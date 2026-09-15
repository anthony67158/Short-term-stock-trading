import csv
import io
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.portfolio import executions, imports, reconciliation, service
from platform_app.modules.portfolio.import_contracts import ImportCommit, ImportInput
from platform_app.modules.portfolio.models import ExecutionImport
from test_executions import fact, ledger  # noqa: F401


def csv_facts(*facts):
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=imports.HEADERS)
    writer.writeheader()
    for body in facts:
        raw = body.model_dump(mode="json", by_alias=True)
        raw.update(raw.pop("fees"))
        writer.writerow({key: raw[key] for key in imports.HEADERS})
    return output.getvalue()


def test_import_preview_rolls_back_then_atomic_commit_and_duplicate_file(ledger):  # noqa: F811
    owner, account = ledger
    buy, sale = fact(qty=37), fact(side="SELL", qty=12, day=1, price="12", fee="1")
    body = ImportInput(csv_text=csv_facts(buy, sale), expected_version=2)
    key = new_id()
    preview = imports.preview_import(owner, account, body, key)
    assert preview.status == "READY"
    assert [row.status for row in preview.rows] == ["NEW", "NEW"]
    assert service.balance(owner, account).cash_balance == 10000
    assert executions.execution_history(owner, account, None, 50).executions == []
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda _: imports.commit_import(
            owner, account, preview.id, ImportCommit(expected_version=2)), range(3)))
    assert all(result.status == "COMMITTED" for result in results)
    assert service.balance(owner, account).account.version == 4
    assert service.balance(owner, account).cash_balance == 9768
    assert reconciliation.reconcile(owner, account).matches
    assert imports.preview_import(owner, account, body, key).status == "READY"  # Frozen receipt.
    duplicate = imports.preview_import(owner, account, body.model_copy(
        update={"expected_version": 4}), new_id())
    assert [row.status for row in duplicate.rows] == ["DUPLICATE", "DUPLICATE"]
    imports.commit_import(owner, account, duplicate.id, ImportCommit(expected_version=4))
    assert service.balance(owner, account).account.version == 4
    assert reconciliation.reconcile(owner, account).matches


def test_import_errors_never_partially_commit_and_protect_ownership(ledger):  # noqa: F811
    owner, account = ledger
    buy = fact(qty=37)
    invalid_sale = fact(side="SELL", qty=38, day=1)
    preview = imports.preview_import(owner, account, ImportInput(
        csv_text=csv_facts(buy, invalid_sale), expected_version=2), new_id())
    assert preview.status == "REJECTED"
    assert [row.status for row in preview.rows] == ["NEW", "ERROR"]
    with pytest.raises(service.PortfolioError, match="存在错误"):
        imports.commit_import(owner, account, preview.id, ImportCommit(expected_version=2))
    assert service.balance(owner, account).account.version == 2
    assert executions.positions(owner, account, None, 50).positions == []
    with pytest.raises(service.PortfolioError) as error:
        imports.get_import(new_id(), account, preview.id)
    assert error.value.status == 404
    malformed = csv_facts(buy).replace(",37,", ",37.1,")
    assert imports.preview_import(owner, account, ImportInput(
        csv_text=malformed, expected_version=2), new_id()).status == "REJECTED"


def test_import_stale_or_expired_preview_is_rejected(ledger):  # noqa: F811
    owner, account = ledger
    body = ImportInput(csv_text=csv_facts(fact()), expected_version=2)
    preview = imports.preview_import(owner, account, body, new_id())
    with sessions().begin() as db:
        db.get(ExecutionImport, preview.id).expires_at = utcnow() - timedelta(seconds=1)
    with pytest.raises(service.PortfolioError, match="已过期"):
        imports.commit_import(owner, account, preview.id, ImportCommit(expected_version=2))
    preview = imports.preview_import(owner, account, body, new_id())
    executions.record_execution(owner, account, fact(day=3), new_id())
    with pytest.raises(service.PortfolioError, match="新记录"):
        imports.commit_import(owner, account, preview.id, ImportCommit(expected_version=2))
    assert service.balance(owner, account).account.version == 3
