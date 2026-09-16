from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from platform_app.adapters.database import sessions
from platform_app.contracts.base import new_id, utcnow
from platform_app.modules.operations.models import Notification, Outbox
from platform_app.modules.operations.notification_contracts import (
    NotificationPage,
    NotificationView,
)


class NotificationError(ValueError):
    def __init__(self, code: str, message: str, status: int = 422):
        self.code, self.message, self.status = code, message, status


def _content(event: Outbox) -> tuple[str, str, str] | None:
    if event.event_type == "decision.updated":
        action = event.payload.get("action", "NONE")
        status = event.payload.get("status", "UNAVAILABLE")
        return (
            "ACTION" if status == "READY" and action != "HOLD" else "INFO",
            "持仓联合建议已更新",
            f"{event.payload.get('instrumentId', '持仓')} · {action}",
        )
    if event.event_type == "monitor.triggered":
        return (
            "INFO",
            "持仓监控已触发复核",
            f"{event.payload.get('instrumentId', '持仓')} 已进入联合评估队列",
        )
    if event.event_type == "monitor.failed":
        return (
            "WARNING",
            "持仓监控未能发起复核",
            str(event.payload.get("errorCode", "MONITOR_FAILED")),
        )
    if event.event_type == "research.assessment.updated":
        return (
            "INFO",
            "股票研判已更新",
            str(event.payload.get("instrumentId", "研究结果")),
        )
    if event.event_type == "portfolio.changed" and event.payload.get("planId"):
        return (
            "INFO",
            "执行计划状态已更新",
            f"账户 {event.payload.get('accountId', '')}",
        )
    return None


def deliver_outbox(limit: int = 100) -> int:
    delivered = 0
    with sessions().begin() as db:
        rows = list(
            db.scalars(
                select(Outbox)
                .where(Outbox.delivered_at.is_(None))
                .order_by(Outbox.created_at, Outbox.id)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        )
        now = utcnow()
        for event in rows:
            content = _content(event)
            if content is not None:
                severity, title, message = content
                db.execute(
                    insert(Notification)
                    .values(
                        id=new_id(),
                        owner_id=event.owner_id,
                        source_outbox_id=event.id,
                        event_type=event.event_type,
                        aggregate_id=event.aggregate_id,
                        severity=severity,
                        title=title,
                        message=message,
                        payload=event.payload,
                        created_at=event.created_at,
                    )
                    .on_conflict_do_nothing(
                        index_elements=["source_outbox_id"]
                    )
                )
                delivered += 1
            event.delivered_at = now
    return delivered


def list_notifications(
    owner_id: str,
    cursor: str | None,
    limit: int,
) -> NotificationPage:
    with sessions()() as db:
        query = select(Notification).where(
            Notification.owner_id == owner_id
        )
        if cursor:
            boundary = db.scalar(
                select(Notification).where(
                    Notification.id == cursor,
                    Notification.owner_id == owner_id,
                )
            )
            if boundary is None:
                raise NotificationError(
                    "NOTIFICATION_CURSOR_INVALID",
                    "通知游标不存在",
                    422,
                )
            query = query.where(
                (Notification.created_at < boundary.created_at)
                | (
                    (Notification.created_at == boundary.created_at)
                    & (Notification.id < boundary.id)
                )
            )
        rows = list(
            db.scalars(
                query.order_by(
                    Notification.created_at.desc(),
                    Notification.id.desc(),
                ).limit(limit + 1)
            )
        )
        unread = db.scalar(
            select(func.count())
            .select_from(Notification)
            .where(
                Notification.owner_id == owner_id,
                Notification.read_at.is_(None),
            )
        )
        return NotificationPage(
            notifications=[
                NotificationView.model_validate(row)
                for row in rows[:limit]
            ],
            unread_count=unread,
            next_cursor=rows[limit - 1].id if len(rows) > limit else None,
        )


def mark_read(owner_id: str, notification_id: str) -> NotificationView:
    with sessions().begin() as db:
        notification = db.scalar(
            select(Notification)
            .where(
                Notification.id == notification_id,
                Notification.owner_id == owner_id,
            )
            .with_for_update()
        )
        if notification is None:
            raise NotificationError(
                "NOTIFICATION_NOT_FOUND",
                "通知不存在或无权访问",
                404,
            )
        if notification.read_at is None:
            notification.read_at = utcnow()
        return NotificationView.model_validate(notification)
