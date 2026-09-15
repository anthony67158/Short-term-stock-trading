import json
import secrets
from datetime import timedelta

import pytest
import httpx
from pydantic import SecretStr, ValidationError
from sqlalchemy import delete, select

from platform_app.adapters.database import sessions
from platform_app.config import settings
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.identity.models import User
from platform_app.modules.identity.service import create_user
from platform_app.modules.market.models import Instrument
from platform_app.modules.operations import jobs
from platform_app.modules.operations.models import Job, Outbox
from platform_app.modules.research import service, worker
from platform_app.modules.research import agent
from platform_app.modules.research.agent import AgentFailure, validate_output
from platform_app.modules.research.contracts import EvidenceInput, ResearchInput
from platform_app.modules.research.models import Assessment, Evidence


@pytest.fixture
def research_owner():
    owner = create_user("research-test-" + new_id(), secrets.token_urlsafe(24))
    code = "SZ.999991"
    with sessions().begin() as db:
        db.add(Instrument(
            id=code, code="999991", exchange="SZ", name="合成研究证券",
            board="UNKNOWN", first_seen_at=utcnow(), last_seen_at=utcnow(), is_current=False,
        ))
    yield owner, code
    with sessions().begin() as db:
        db.execute(delete(Assessment).where(Assessment.owner_id == owner))
        db.execute(delete(Evidence).where(Evidence.owner_id == owner))
        db.execute(delete(Job).where(Job.owner_id == owner))
        db.execute(delete(Outbox).where(Outbox.owner_id == owner))
        db.execute(delete(User).where(User.id == owner))
        db.execute(delete(Instrument).where(Instrument.id == code))


def evidence(owner, code):
    return service.save_evidence(owner, EvidenceInput(
        instrument_id=code, title="合成测试原文", source_url="https://example.com/synthetic",
        published_at=utcnow() - timedelta(days=1),
        text="这是一份明确标注为合成的测试研究材料。公司订单尚待验证，不构成真实投资信息。",
        quote="公司订单尚待验证，不构成真实投资信息。",
    ), new_id())


def output(payload):
    return {
        "summary": "合成研究论点，需要继续补证据",
        "claims": [{"kind": "OBSERVED", "statement": payload["evidence"][0]["quote"],
                    "evidence_ids": [payload["evidence"][0]["id"]]}],
        "counter_claims": [], "thesis_status": "UNCERTAIN", "strategy_fit": ["EVENT"],
        "uncertainties": ["材料未经外部核验"], "invalidation": "来源核验不成立",
        "next_check": "核验原始公告", "valid_until": (utcnow() + timedelta(hours=1)).isoformat(),
    }


def test_evidence_immutable_idempotent_quote_scope_and_future(research_owner):
    owner, code = research_owner
    first = evidence(owner, code)
    assert first.available_at >= first.first_seen_at > first.published_at
    assert first.provenance == "USER_SUPPLIED"
    with pytest.raises(service.ResearchError) as exc:
        service.evidence_by_id(new_id(), first.id)
    assert exc.value.status == 404
    body = EvidenceInput.model_validate(first.model_dump(include=set(EvidenceInput.model_fields)))
    with pytest.raises(service.ResearchError, match="逐字定位"):
        service.save_evidence(owner, body.model_copy(update={"quote": "原文中没有这段文字"}), new_id())
    with pytest.raises(service.ResearchError, match="不能晚于"):
        service.save_evidence(owner, body.model_copy(update={
            "published_at": utcnow() + timedelta(days=1),
        }), new_id())
    updated = service.save_evidence(owner, body.model_copy(update={"text": body.text + "新增材料。"}), new_id())
    assert updated.id != first.id and updated.content_hash != first.content_hash
    assert service.evidence_by_id(owner, first.id).text == first.text


def test_research_fenced_publish_cancel_and_output_validation(research_owner, monkeypatch):
    owner, code = research_owner
    source = evidence(owner, code)
    config = settings().model_copy(update={"agent_enabled": True, "agent_api_key": SecretStr("synthetic")})
    monkeypatch.setattr(service, "settings", lambda: config)
    request = ResearchInput(instrument_id=code, question="核验合成材料的主要证据缺口", evidence_ids=[source.id])
    key = new_id()
    job = service.submit_research(owner, request, key)
    assert service.submit_research(owner, request, key).id == job.id
    raw = output(job.payload)
    validated = validate_output(json.dumps(raw), job.payload)
    raw["targetQuantity"] = 100
    with pytest.raises(ValidationError):
        validate_output(json.dumps(raw), job.payload)
    raw = output(job.payload)
    raw["claims"][0]["evidence_ids"] = ["not-in-input"]
    with pytest.raises(AgentFailure, match="INVALID_EVIDENCE_REFERENCE"):
        validate_output(json.dumps(raw), job.payload)
    monkeypatch.setattr(worker, "run_agent", lambda payload: validated)
    assert worker.process_one()
    with sessions()() as db:
        assert db.get(Job, job.id).status == "SUCCEEDED"
        assert db.scalar(select(Assessment).where(Assessment.job_id == job.id))
    cancelled = service.submit_research(owner, request, new_id())

    def cancel_during_call(payload):
        jobs.cancel(owner, cancelled.id)
        return validated

    monkeypatch.setattr(worker, "run_agent", cancel_during_call)
    assert worker.process_one()
    with sessions()() as db:
        assert db.get(Job, cancelled.id).status == "CANCELLED"
        assert db.scalar(select(Assessment).where(Assessment.job_id == cancelled.id)) is None


def test_agent_http_contract_and_auth_failure_without_retry(research_owner, monkeypatch):
    owner, code = research_owner
    source = evidence(owner, code)
    config = settings().model_copy(update={
        "agent_enabled": True, "agent_api_key": SecretStr("synthetic-only"),
    })
    monkeypatch.setattr(service, "settings", lambda: config)
    monkeypatch.setattr(agent, "settings", lambda: config)
    job = service.submit_research(owner, ResearchInput(
        instrument_id=code, question="仅用于传输合同验证的合成问题", evidence_ids=[source.id],
    ), new_id())
    original = httpx.AsyncClient
    calls = []

    def handle(request):
        body = json.loads(request.content)
        assert body["model"] == "gpt-5.6-terra"
        calls.append(request.url.path)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": json.dumps(output(job.payload))}}],
        })

    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(
        **kwargs, transport=httpx.MockTransport(handle),
    ))
    assert agent.run_agent(job.payload).thesis_status == "UNCERTAIN"
    assert calls == ["/v1/chat/completions"]
    monkeypatch.setattr(agent.httpx, "AsyncClient", lambda **kwargs: original(
        **kwargs, transport=httpx.MockTransport(lambda request: httpx.Response(401)),
    ))
    with pytest.raises(AgentFailure, match="AGENT_AUTH_FAILED"):
        agent.run_agent(job.payload)
