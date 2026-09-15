from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal

import pytest
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import delete, select, update

from platform_app.adapters.database import sessions
from platform_app.contracts.base import Money, Quantity, new_id, utcnow
from platform_app.modules.operations.jobs import (
    JobConflict, cancel, claim, finish, mark_external, submit,
)
from platform_app.modules.operations.models import Job, Outbox


def test_money_and_quantity_do_not_coerce_lossy_inputs():
    money = TypeAdapter(Money)
    assert money.validate_python("100.01") == Decimal("100.01")
    assert money.dump_json(Decimal("100.01")) == b'"100.01"'
    for value in [100.01, "NaN", "Infinity", "1.001", True]:
        with pytest.raises((ValidationError, ValueError)):
            money.validate_python(value)
    for value in [True, 1.5, "100", -1]:
        with pytest.raises(ValidationError):
            TypeAdapter(Quantity).validate_python(value)


@pytest.fixture
def scope():
    owner = new_id()
    kind = "test_" + owner[:20]
    yield owner, kind
    with sessions().begin() as db:
        db.execute(delete(Outbox).where(Outbox.owner_id == owner))
        db.execute(delete(Job).where(Job.owner_id == owner))


def test_idempotency_and_parallel_claim(scope):
    owner, kind = scope
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = list(pool.map(lambda _: submit(owner, kind, "same", {"a": 1}), range(4)))
    assert len({job.id for job in jobs}) == 1
    with pytest.raises(JobConflict):
        submit(owner, kind, "same", {"a": 2})
    with ThreadPoolExecutor(max_workers=4) as pool:
        claimed = list(pool.map(lambda _: claim([kind]), range(4)))
    assert len([job for job in claimed if job]) == 1


def test_expired_worker_cannot_publish_or_duplicate_external_call(scope):
    owner, kind = scope
    submit(owner, kind, "fence", {})
    old = claim([kind])
    with sessions().begin() as db:
        db.execute(update(Job).where(Job.id == old.id).values(
            lease_until=utcnow() - timedelta(seconds=1),
        ))
    current = claim([kind])
    assert current.fencing_token > old.fencing_token
    assert not finish(old, {"stale": True})
    assert mark_external(current)
    with sessions().begin() as db:
        db.execute(update(Job).where(Job.id == old.id).values(
            lease_until=utcnow() - timedelta(seconds=1),
        ))
    assert claim([kind]) is None
    with sessions()() as db:
        assert db.get(Job, old.id).status == "FAILED"
    assert not finish(current, {"late": True})


def test_cancel_before_publication_and_transactional_outbox(scope):
    owner, kind = scope
    submit(owner, kind, "cancel", {})
    job = claim([kind])
    assert cancel("another-owner", job.id) is None
    cancel(owner, job.id)
    assert not mark_external(job)
    assert finish(job, {"mustNotPublish": True})
    with sessions()() as db:
        saved = db.get(Job, job.id)
        assert saved.status == "CANCELLED" and saved.result is None
        assert len(db.scalars(select(Outbox).where(Outbox.aggregate_id == job.id)).all()) == 1
