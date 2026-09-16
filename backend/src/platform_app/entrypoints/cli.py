import argparse
import getpass
import json
import os
import re
from itertools import groupby
from pathlib import Path


def external_dataset_root(value: Path) -> Path:
    if not value.is_absolute():
        raise ValueError("dataset-root must be an absolute path")
    target = value.resolve()
    repository = Path(__file__).resolve().parents[4]
    if target == repository or repository in target.parents:
        raise ValueError("dataset-root must be outside the repository")
    return target


def cross_source_sample(value: str) -> tuple[str, str]:
    if not re.fullmatch(r"(SH|SZ|BJ)\.\d{6}@\d{8}", value):
        raise argparse.ArgumentTypeError("sample must be INSTRUMENT_ID@YYYYMMDD")
    instrument_id, trade_date = value.split("@", maxsplit=1)
    return instrument_id, trade_date


def main():
    parser = argparse.ArgumentParser(description="A股投资平台")
    parser.add_argument(
        "command",
        choices=[
            "export-contracts",
            "health",
            "create-user",
            "sync-instruments",
            "audit-market-archive",
            "audit-market-cross-source",
            "audit-market-dataset",
            "upgrade-market-dataset",
            "build-market-dataset",
            "build-episode-dataset",
        ],
    )
    parser.add_argument("--username")
    parser.add_argument("--archive-root", action="append", type=Path)
    parser.add_argument("--securities-file", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--dataset-root", type=Path)
    parser.add_argument("--source-dataset-root", type=Path)
    parser.add_argument("--episode-root", type=Path)
    parser.add_argument("--dataset-id")
    parser.add_argument("--episode-dataset-id")
    parser.add_argument("--start-date")
    parser.add_argument("--end-date")
    parser.add_argument(
        "--stage",
        choices=[
            "reference",
            "names",
            "daily",
            "block-trades",
            "minute",
            "candidates",
            "minute-requirements",
            "archive-minutes",
            "seal",
        ],
    )
    parser.add_argument("--instrument-id", action="append")
    parser.add_argument("--sample", action="append", type=cross_source_sample)
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
        print(
            json.dumps(
                {
                    "chunks": report["chunkCount"],
                    "from": report["from"],
                    "to": report["to"],
                    "productionEligible": False,
                }
            )
        )
    elif args.command == "audit-market-cross-source":
        from platform_app.modules.experiments.market_cross_source_audit import (
            audit_cross_sources,
        )

        if not args.dataset_root or not args.output or not args.sample:
            parser.error("dataset-root, output and sample are required")
        try:
            dataset_root = external_dataset_root(args.dataset_root)
        except ValueError as exc:
            parser.error(str(exc))
        report = audit_cross_sources(dataset_root, args.sample)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        os.replace(temporary, args.output)
        print(
            json.dumps(
                {
                    "samples": report["summary"]["samples"],
                    "passed": report["passed"],
                    "reportSha256": report["reportSha256"],
                }
            )
        )
    elif args.command == "audit-market-dataset":
        from platform_app.modules.experiments.market_dataset_audit import audit_market_dataset

        if not args.dataset_root or not args.output:
            parser.error("dataset-root and output are required")
        try:
            dataset_root = external_dataset_root(args.dataset_root)
        except ValueError as exc:
            parser.error(str(exc))
        report = audit_market_dataset(dataset_root)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        os.replace(temporary, args.output)
        print(
            json.dumps(
                {
                    "passed": report["passed"],
                    "dailyBars": report["totals"]["dailyBars"],
                    "openDates": report["range"]["openDates"],
                    "reportSha256": report["reportSha256"],
                }
            )
        )
    elif args.command == "upgrade-market-dataset":
        from platform_app.modules.experiments.market_dataset import (
            upgrade_market_dataset,
        )

        if not args.source_dataset_root or not args.dataset_root or not args.dataset_id:
            parser.error("source-dataset-root, dataset-root and dataset-id are required")
        try:
            source_root = external_dataset_root(args.source_dataset_root)
            dataset_root = external_dataset_root(args.dataset_root)
        except ValueError as exc:
            parser.error(str(exc))
        print(
            json.dumps(
                upgrade_market_dataset(
                    source_root,
                    dataset_root,
                    dataset_id=args.dataset_id,
                ),
                ensure_ascii=False,
            )
        )
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
                parser.error("non-seal stages require ordered YYYYMMDD date values")
            if args.stage == "minute" and (
                not args.instrument_id
                or len(args.instrument_id) != len(set(args.instrument_id))
                or any(
                    not re.fullmatch(r"(SH|SZ|BJ)\.\d{6}", value) for value in args.instrument_id
                )
            ):
                parser.error("minute stage requires unique SH/SZ/BJ instrument-id values")
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
                elif args.stage == "daily":
                    dates = dataset.db.execute(
                        "SELECT cal_date FROM trade_calendar "
                        "WHERE is_open = 1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date",
                        (args.start_date, args.end_date),
                    )
                    for (trade_date,) in dates.fetchall():
                        print(
                            json.dumps(
                                builder.sync_daily_partition(trade_date),
                                ensure_ascii=False,
                            ),
                            flush=True,
                        )
                elif args.stage == "block-trades":
                    dates = [
                        row[0]
                        for row in dataset.db.execute(
                            "SELECT cal_date FROM trade_calendar "
                            "WHERE is_open = 1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date",
                            (args.start_date, args.end_date),
                        )
                    ]
                    for _month, month_dates in groupby(dates, key=lambda value: value[:6]):
                        partition = list(month_dates)
                        print(
                            json.dumps(
                                builder.sync_block_trade_range(
                                    partition[0],
                                    partition[-1],
                                ),
                                ensure_ascii=False,
                            ),
                            flush=True,
                        )
                else:
                    dates = dataset.db.execute(
                        "SELECT cal_date FROM trade_calendar "
                        "WHERE is_open = 1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date",
                        (args.start_date, args.end_date),
                    ).fetchall()
                    for (trade_date,) in dates:
                        for instrument_id in args.instrument_id:
                            print(
                                json.dumps(
                                    builder.sync_minute_partition(instrument_id, trade_date),
                                    ensure_ascii=False,
                                ),
                                flush=True,
                            )
    elif args.command == "build-episode-dataset":
        from platform_app.modules.experiments.candidate_episode_builder import (
            CandidateEpisodeBuilder,
        )
        from platform_app.modules.experiments.episode_dataset import EpisodeDataset
        from platform_app.modules.experiments.minute_archive_importer import (
            MinuteArchiveImporter,
        )
        from platform_app.modules.experiments.minute_requirement_builder import (
            MinuteRequirementBuilder,
        )
        from platform_app.modules.experiments.short_horizon_policy import (
            SHORT_HORIZON_POLICY,
        )

        if not all(
            (
                args.dataset_root,
                args.episode_root,
                args.episode_dataset_id,
                args.stage,
            )
        ):
            parser.error("dataset-root, episode-root, episode-dataset-id and stage are required")
        if args.stage not in {
            "candidates",
            "minute-requirements",
            "archive-minutes",
            "seal",
        }:
            parser.error(
                "episode dataset stage must be candidates, minute-requirements, "
                "archive-minutes or seal"
            )
        if args.stage in {"candidates", "minute-requirements", "archive-minutes"} and (
            not args.start_date
            or not args.end_date
            or not re.fullmatch(r"\d{8}", args.start_date)
            or not re.fullmatch(r"\d{8}", args.end_date)
            or args.start_date > args.end_date
        ):
            parser.error("candidates stage requires ordered YYYYMMDD date values")
        if args.stage == "archive-minutes" and not args.archive_root:
            parser.error("archive-minutes stage requires archive-root")
        try:
            market_root = external_dataset_root(args.dataset_root)
            episode_root = external_dataset_root(args.episode_root)
        except ValueError as exc:
            parser.error(str(exc))
        with EpisodeDataset(
            episode_root,
            dataset_id=args.episode_dataset_id,
            market_dataset_root=market_root,
            policy=SHORT_HORIZON_POLICY,
        ) as dataset:
            if args.stage == "seal":
                print(json.dumps(dataset.seal(), ensure_ascii=False))
            elif args.stage == "archive-minutes":
                for archive_root in args.archive_root:
                    with MinuteArchiveImporter(
                        dataset,
                        external_dataset_root(archive_root),
                    ) as importer:
                        results = importer.import_range(args.start_date, args.end_date)
                    for result in results:
                        print(json.dumps(result, ensure_ascii=False), flush=True)
            elif args.stage == "minute-requirements":
                with MinuteRequirementBuilder(dataset) as builder:
                    results = builder.build_range(args.start_date, args.end_date)
                for result in results:
                    print(json.dumps(result, ensure_ascii=False), flush=True)
            else:
                with CandidateEpisodeBuilder(
                    dataset,
                    SHORT_HORIZON_POLICY,
                ) as builder:
                    results = builder.build_range(args.start_date, args.end_date)
                for result in results:
                    print(json.dumps(result, ensure_ascii=False), flush=True)
    elif args.command == "create-user":
        from platform_app.modules.identity.service import create_user

        name = args.username or input("用户名: ")
        password = getpass.getpass("密码（至少12位）: ")
        if password != getpass.getpass("再次输入密码: "):
            parser.error("两次密码不一致")
        print("用户已创建:", create_user(name, password))


if __name__ == "__main__":
    main()
