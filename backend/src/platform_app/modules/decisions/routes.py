from typing import Annotated

from fastapi import APIRouter, Header, Query

from platform_app.contracts.base import Envelope
from platform_app.modules.decisions import service
from platform_app.modules.decisions import monitoring
from platform_app.modules.decisions import candidates
from platform_app.modules.decisions.candidate_contracts import (
    CandidateScan,
    CandidateScanInput,
)
from platform_app.modules.decisions.monitor_contracts import (
    MonitorPage,
    MonitorUpdate,
    MonitorView,
)
from platform_app.modules.decisions.position_contracts import (
    JointReleaseReference,
    PositionDecision,
    PositionDecisionPage,
    PositionEvaluationInput,
)
from platform_app.modules.identity.routes import CurrentUser
from platform_app.modules.portfolio.plan_contracts import (
    DecisionPlanInput,
    PlanView,
)
from platform_app.modules.research.contracts import JobView

router = APIRouter(prefix="/api/v1", tags=["decisions"])
CommandKey = Annotated[
    str,
    Header(alias="Idempotency-Key", min_length=8, max_length=128),
]


@router.get(
    "/decision-capability",
    response_model=Envelope[JointReleaseReference],
)
def decision_capability(_user: CurrentUser):
    return Envelope(data=service.active_release())


@router.post(
    "/accounts/{account_id}/evaluations",
    response_model=Envelope[JobView],
    status_code=202,
)
def evaluate_position(
    account_id: str,
    body: PositionEvaluationInput,
    user: CurrentUser,
    key: CommandKey,
):
    return Envelope(
        data=JobView.model_validate(
            service.submit_position_evaluation(user.id, account_id, body, key)
        )
    )


@router.get(
    "/accounts/{account_id}/decisions",
    response_model=Envelope[PositionDecisionPage],
)
def list_current_decisions(
    account_id: str,
    user: CurrentUser,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    return Envelope(
        data=service.current_decisions(user.id, account_id, cursor, limit)
    )


@router.get(
    "/decisions/{decision_id}",
    response_model=Envelope[PositionDecision],
)
def get_decision(decision_id: str, user: CurrentUser):
    return Envelope(data=service.decision_by_id(user.id, decision_id))


@router.post(
    "/decisions/{decision_id}/plans",
    response_model=Envelope[PlanView],
    status_code=201,
)
def create_decision_plan(
    decision_id: str,
    body: DecisionPlanInput,
    user: CurrentUser,
    key: CommandKey,
):
    return Envelope(
        data=service.create_execution_plan(
            user.id,
            decision_id,
            body,
            key,
        )
    )


@router.get(
    "/accounts/{account_id}/monitors",
    response_model=Envelope[MonitorPage],
)
def list_monitors(account_id: str, user: CurrentUser):
    return Envelope(data=monitoring.monitors(user.id, account_id))


@router.put(
    "/decisions/{decision_id}/monitor",
    response_model=Envelope[MonitorView],
)
def set_monitor(
    decision_id: str,
    body: MonitorUpdate,
    user: CurrentUser,
):
    return Envelope(
        data=monitoring.update_monitor(user.id, decision_id, body)
    )


@router.post(
    "/candidate-scans",
    response_model=Envelope[JobView],
    status_code=202,
)
def create_candidate_scan(
    body: CandidateScanInput,
    user: CurrentUser,
    key: CommandKey,
):
    return Envelope(
        data=JobView.model_validate(
            candidates.submit_scan(user.id, body, key)
        )
    )


@router.get(
    "/candidate-scans/latest",
    response_model=Envelope[CandidateScan | None],
)
def get_latest_candidate_scan(user: CurrentUser):
    return Envelope(data=candidates.latest_scan(user.id))
