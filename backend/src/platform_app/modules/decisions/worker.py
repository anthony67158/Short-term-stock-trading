import time

from platform_app.modules.decisions.candidates import (
    process_one as process_candidate,
)
from platform_app.modules.decisions.monitoring import mark_failed_jobs, trigger_due
from platform_app.modules.decisions.service import process_one
from platform_app.modules.operations.notifications import deliver_outbox


def main():
    while True:
        try:
            processed = process_one()
            candidate = process_candidate()
            triggered = trigger_due()
            failed = mark_failed_jobs()
            delivered = deliver_outbox()
        except Exception:
            print("决策Worker暂时失败，等待任务租约恢复", flush=True)
            processed = candidate = triggered = failed = delivered = 0
        if not any((processed, candidate, triggered, failed, delivered)):
            time.sleep(1)


if __name__ == "__main__":
    main()
