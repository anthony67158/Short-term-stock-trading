from typing import Annotated

from fastapi import APIRouter, Query

from platform_app.contracts.base import Envelope
from platform_app.modules.identity.routes import CurrentUser
from platform_app.modules.operations import notifications
from platform_app.modules.operations.notification_contracts import (
    NotificationPage,
    NotificationView,
)

router = APIRouter(prefix="/api/v1/notifications", tags=["notifications"])


@router.get("", response_model=Envelope[NotificationPage])
def notification_list(
    user: CurrentUser,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    return Envelope(
        data=notifications.list_notifications(user.id, cursor, limit)
    )


@router.post(
    "/{notification_id}/read",
    response_model=Envelope[NotificationView],
)
def read_notification(notification_id: str, user: CurrentUser):
    return Envelope(
        data=notifications.mark_read(user.id, notification_id)
    )
