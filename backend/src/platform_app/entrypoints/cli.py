import argparse
import getpass
import json
import re
from pathlib import Path


def external_dataset_root(value: Path) -> Path:
    if not value.is_absolute():
        raise ValueError("dataset-root must be an absolute path")
    target = value.resolve()
    repository = Path(__file__).resolve().parents[4]
    if target == repository or repository in target.parents:
        raise ValueError("dataset-root must be outside the repository")
    return target


def main():
    parser = argparse.ArgumentParser(description="A股投资平台")
    parser.add_argument("command", choices=[
        "export-contracts", "health", "create-user", "sync-instruments", "audit-market-archive",
        "build-market-dataset",
    ])
    parser.add_argument("--username")
    parser.add_argument("--archive-root", action="append", type=Path)
    parser.add_argument("--securities-file", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--dataset-root", type=Path)
    parser.add_argument("--dataset-id")
    parser.add_argument("--start-date")
    parser.add_argument("--end-date")
    parser.add_argument("--stage", choices=["reference", "names", "daily", "seal"])
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
    elif args.command == "audit-market-archive":
        from platform_app.modules.experiments.dataset_audit import audit_roots

        if not args.archive_root or not args.output:
            parser.error("archive-root and output are required")
        report = audit_roots(args.archive_root, args.securities_file)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"chunks": report["chunkCount"], "from": report["from"],
                          "to": report["to"], "productionEligible": False}))
    elif args.command == "build-market-dataset":
        from platform_app.adapters.market_tushare import TushareClient
        from platform_app.modules.experiments.market_dataset import MarketDataset
        from platform_app.modules.experiments.market_dataset_builder import MarketDatasetBuilder

        if not all((args.dataset_root, args.dataset_id, args.stage)):
            parser.error("dataset-root, dataset-id and stage are required")
        if args.stage != "seal":
            if (
                not args.start_date
                or not args.end_date
                or not re.fullmatch(r"\d{8}", args.start_date)
                or not re.fullmatch(r"\d{8}", args.end_date)
                or args.start_date > args.end_date
            ):
                parser.error("reference/names/daily dates must be ordered YYYYMMDD values")
        try:
            dataset_root = external_dataset_root(args.dataset_root)
        except ValueError as exc:
            parser.error(str(exc))
        with MarketDataset(
            dataset_root,
            dataset_id=args.dataset_id,
            source="TUSHARE_COMPATIBLE",
        ) as dataset:
            if args.stage == "seal":
                print(json.dumps(dataset.seal(), ensure_ascii=False))
            else:
                builder = MarketDatasetBuilder(TushareClient(), dataset)
                if args.stage == "reference":
                    result = builder.sync_reference(args.start_date, args.end_date)
                    print(json.dumps(result, ensure_ascii=False))
                elif args.stage == "names":
                    result = builder.sync_name_changes(args.start_date, args.end_date)
                    print(json.dumps(result, ensure_ascii=False))
                else:
                    dates = dataset.db.execute(
                        "SELECT cal_date FROM trade_calendar "
                        "WHERE is_open = 1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date",
                        (args.start_date, args.end_date),
                    )
                    for (trade_date,) in dates.fetchall():
                        print(json.dumps(
                            builder.sync_daily_partition(trade_date),
                            ensure_ascii=False,
                        ), flush=True)
    elif args.command == "create-user":
        from platform_app.modules.identity.service import create_user

        name = args.username or input("用户名: ")
        password = getpass.getpass("密码（至少12位）: ")
        if password != getpass.getpass("再次输入密码: "):
            parser.error("两次密码不一致")
        print("用户已创建:", create_user(name, password))


if __name__ == "__main__":
    main()
