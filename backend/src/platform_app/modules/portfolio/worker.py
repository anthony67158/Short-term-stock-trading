"""Independent ledger maintenance; never waits for a research/model call."""
import time

from platform_app.modules.portfolio.plans import expire_due


def main():
    while True:
        try:
            expire_due()
        except Exception:
            # Transaction rollback preserves audit atomicity. No private facts in logs.
            print("账本维护暂时失败，下轮重试", flush=True)
        time.sleep(1)


if __name__ == "__main__":
    main()
