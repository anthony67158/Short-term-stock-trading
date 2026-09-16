from typing import Annotated

from fastapi import APIRouter, Header, Query

from platform_app.contracts.base import Envelope
from platform_app.modules.identity.routes import CurrentUser
from platform_app.modules.research.contracts import JobView
from platform_app.modules.research.routes import job_view
from platform_app.modules.review import service
from platform_app.modules.review.contracts import (
    ReviewCapability,
    ReviewReportPage,
    ReviewRunInput,
)

router = APIRouter(prefix="/api/v1", tags=["review"])
CommandKey = Annotated[
    str,
    Header(alias="Idempotency-Key", min_length=8, max_length=128),
]


@router.get(
    "/review-capability",
    response_model=Envelope[ReviewCapability],
)
def review_capability(_user: CurrentUser):
    return Envelope(data=service.capability())


@router.post(
    "/review-runs",
    response_model=Envelope[JobView],
    status_code=202,
)
def run_review(
    body: ReviewRunInput,
    user: CurrentUser,
    key: CommandKey,
):
    return Envelope(
        data=job_view(service.submit_review(user.id, body, key))
    )


@router.get(
    "/reviews",
    response_model=Envelope[ReviewReportPage],
)
def list_reviews(
    user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
):
    return Envelope(data=service.reports(user.id, limit))
