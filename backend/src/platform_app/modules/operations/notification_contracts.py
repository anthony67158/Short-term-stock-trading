from typing import Literal

from pydantic import AwareDatetime

from platform_app.contracts.base import Contract


class NotificationView(Contract):
    id: str
    event_type: str
    aggregate_id: str
    severity: Literal["INFO", "ACTION", "WARNING"]
    title: str
    message: str
    payload: dict
    created_at: AwareDatetime
    read_at: AwareDatetime | None


class NotificationPage(Contract):
    notifications: list[NotificationView]
    unread_count: int
    next_cursor: str | None
