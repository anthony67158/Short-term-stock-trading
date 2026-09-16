from typing import Annotated

from fastapi import APIRouter, Header, Query

from platform_app.contracts.base import Envelope
from platform_app.modules.decisions import service
from platform_app.modules.decisions.position_contracts import (
    PositionDecision,
    PositionDecisionPage,
    PositionEvaluationInput,
)
from platform_app.modules.identity.routes import CurrentUser
from platform_app.modules.research.contracts import JobView

router = APIRouter(prefix="/api/v1", tags=["decisions"])
CommandKey = Annotated[
    str,
    Header(alias="Idempotency-Key", min_length=8, max_length=128),
]


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
