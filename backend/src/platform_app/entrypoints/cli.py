import argparse
import getpass
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="A股投资平台")
    parser.add_argument("command", choices=[
        "export-contracts", "health", "create-user", "sync-instruments",
    ])
    parser.add_argument("--username")
    args = parser.parse_args()
    if args.command == "export-contracts":
        from platform_app.entrypoints.api import app

        root = Path(__file__).resolve().parents[4]
        target = root / "contracts" / "openapi.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n")
        print(target)
    elif args.command == "health":
        from platform_app.entrypoints.api import health

        print(health().model_dump_json(by_alias=True))
    elif args.command == "sync-instruments":
        from platform_app.modules.market.service import sync_universe

        print(sync_universe().model_dump_json(by_alias=True))
    elif args.command == "create-user":
        from platform_app.modules.identity.service import create_user

        name = args.username or input("用户名: ")
        password = getpass.getpass("密码（至少12位）: ")
        if password != getpass.getpass("再次输入密码: "):
            parser.error("两次密码不一致")
        print("用户已创建:", create_user(name, password))


if __name__ == "__main__":
    main()
