import time

from platform_app.modules.decisions.service import process_one


def main():
    while True:
        try:
            processed = process_one()
        except Exception:
            print("决策Worker暂时失败，等待任务租约恢复", flush=True)
            processed = False
        if not processed:
            time.sleep(1)


if __name__ == "__main__":
    main()
