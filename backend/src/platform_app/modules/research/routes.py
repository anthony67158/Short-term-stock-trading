from typing import Annotated

from fastapi import APIRouter, Header, Query
from sqlalchemy import select

from platform_app.adapters.database import sessions
from platform_app.contracts.base import Envelope, InstrumentId
from platform_app.modules.identity.routes import CurrentUser
from platform_app.modules.operations import jobs
from platform_app.modules.operations.models import Job
from platform_app.modules.research import service
from platform_app.modules.research.contracts import (
    AssessmentPage, EvidenceInput, EvidencePage, EvidenceView, JobView,
    ResearchCapability, ResearchInput,
)

router = APIRouter(prefix="/api/v1", tags=["research"])
CommandKey = Annotated[str, Header(alias="Idempotency-Key", min_length=8, max_length=128)]
Limit = Annotated[int, Query(ge=1, le=50)]
MESSAGES = {
    "AGENT_AUTH_FAILED": "研究服务鉴权失败，请检查供应商账户",
    "AGENT_UNAVAILABLE": "研究服务尚未启用或模型配置已变化",
    "AGENT_RATE_LIMITED": "供应商调用限流，本次研究未完成",
    "AGENT_TIMEOUT_RESULT_UNCERTAIN": "研究超时，上游可能已执行，本次不自动重复调用",
    "WORKER_LOST_EXTERNAL_RESULT_UNCERTAIN": "研究进程失联，上游调用结果未知",
    "INVALID_EVIDENCE_REFERENCE": "研判引用了材料包之外的证据，已拒绝发布",
    "UNSUPPORTED_OBSERVATION": "研判中的事实无法在引用原文定位，已拒绝发布",
    "DEADLINE_EXCEEDED": "研究任务超过有效处理期限",
    "JOINT_RELEASE_CHANGED": "评估期间联合版本已变化，本次结果未发布",
    "ACCOUNT_VERSION_CONFLICT": "评估期间账户已变化，请重新评估",
}


def job_view(job):
    view = JobView.model_validate(job)
    if job.error_code:
        view.message = MESSAGES.get(job.error_code, "研究结果未通过完整性校验，本次未发布")
    return view


@router.get("/research-capability", response_model=Envelope[ResearchCapability])
def research_capability(user: CurrentUser):
    return Envelope(data=service.capability())


@router.post("/evidence", response_model=Envelope[EvidenceView], status_code=201)
def create_evidence(body: EvidenceInput, user: CurrentUser, key: CommandKey):
    return Envelope(data=service.save_evidence(user.id, body, key))


@router.get("/evidence/{evidence_id}", response_model=Envelope[EvidenceView])
def get_evidence(evidence_id: str, user: CurrentUser):
    return Envelope(data=service.evidence_by_id(user.id, evidence_id))


@router.get("/instruments/{instrument_id}/evidence", response_model=Envelope[EvidencePage])
def list_evidence(instrument_id: InstrumentId, user: CurrentUser, cursor: str | None = None, limit: Limit = 20):
    return Envelope(data=service.evidence_list(user.id, instrument_id, cursor, limit))


@router.get("/instruments/{instrument_id}/research", response_model=Envelope[AssessmentPage])
def list_research(instrument_id: InstrumentId, user: CurrentUser, cursor: str | None = None, limit: Limit = 20):
    return Envelope(data=service.assessments(user.id, instrument_id, cursor, limit))


@router.post("/research-runs", response_model=Envelope[JobView], status_code=202)
def research_run(body: ResearchInput, user: CurrentUser, key: CommandKey):
    return Envelope(data=job_view(service.submit_research(user.id, body, key)))


@router.get("/jobs/{job_id}", response_model=Envelope[JobView])
def get_job(job_id: str, user: CurrentUser):
    with sessions()() as db:
        job = db.scalar(select(Job).where(Job.id == job_id, Job.owner_id == user.id))
        if not job:
            raise service.ResearchError("JOB_NOT_FOUND", "任务不存在或无权访问", 404)
        return Envelope(data=job_view(job))


@router.post("/jobs/{job_id}/cancellations", response_model=Envelope[JobView])
def cancel_job(job_id: str, user: CurrentUser):
    job = jobs.cancel(user.id, job_id)
    if not job:
        raise service.ResearchError("JOB_NOT_FOUND", "任务不存在或无权访问", 404)
    return Envelope(data=job_view(job))
