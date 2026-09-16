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


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return parsed


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
            "build-label-dataset",
            "build-ranking-dataset",
            "train-quant-model",
            "train-ranking-model",
            "audit-execution-coverage",
            "build-selected-backtest-dataset",
            "evaluate-quant-backtest",
            "evaluate-account-backtest",
            "build-joint-candidate",
            "publish-joint-shadow",
            "run-daily-joint-cycle",
            "build-position-action-dataset",
            "train-position-action-model",
        ],
    )
    parser.add_argument("--username")
    parser.add_argument("--archive-root", action="append", type=Path)
    parser.add_argument("--securities-file", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--coverage-report", type=Path)
    parser.add_argument("--quant-backtest", type=Path)
    parser.add_argument("--dataset-root", type=Path)
    parser.add_argument("--source-dataset-root", type=Path)
    parser.add_argument("--episode-root", type=Path)
    parser.add_argument("--label-root", type=Path)
    parser.add_argument("--position-root", type=Path)
    parser.add_argument("--ranking-root", type=Path)
    parser.add_argument("--ranking-model-root", type=Path)
    parser.add_argument("--position-model-root", type=Path)
    parser.add_argument("--model-root", type=Path)
    parser.add_argument("--account-backtest", type=Path)
    parser.add_argument("--candidate-root", type=Path)
    parser.add_argument("--registry-root", type=Path)
    parser.add_argument("--dataset-id")
    parser.add_argument("--episode-dataset-id")
    parser.add_argument("--label-dataset-id")
    parser.add_argument("--position-dataset-id")
    parser.add_argument("--ranking-dataset-id")
    parser.add_argument("--model-bundle-id")
    parser.add_argument("--joint-bundle-id")
    parser.add_argument("--release-id")
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
            "fetch-minutes",
            "exhaust-minutes",
            "labels",
            "ranking-samples",
            "seal",
        ],
    )
    parser.add_argument("--instrument-id", action="append")
    parser.add_argument("--reason", action="append")
    parser.add_argument("--resolution-note")
    parser.add_argument("--max-windows", type=positive_int)
    parser.add_argument("--max-sessions", type=positive_int, default=120)
    parser.add_argument("--max-iterations", type=positive_int, default=120)
    parser.add_argument("--minimum-matured-samples", type=positive_int, default=2000)
    parser.add_argument("--top-n", type=positive_int, default=10)
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
    elif args.command == "build-joint-candidate":
        from platform_app.config import settings
        from platform_app.modules.experiments.joint_bundle import (
            write_joint_candidate,
        )

        if not all(
            (
                args.output,
                args.joint_bundle_id,
                args.ranking_model_root,
                args.model_root,
                args.position_model_root,
                args.account_backtest,
            )
        ):
            parser.error(
                "output, joint-bundle-id, ranking-model-root, model-root, "
                "position-model-root and account-backtest are required"
            )
        try:
            output_root = external_dataset_root(args.output)
            ranking_model_root = external_dataset_root(args.ranking_model_root)
            quant_model_root = external_dataset_root(args.model_root)
            position_model_root = external_dataset_root(args.position_model_root)
            account_parent = external_dataset_root(
                args.account_backtest.resolve().parent
            )
        except ValueError as exc:
            parser.error(str(exc))
        print(
            json.dumps(
                write_joint_candidate(
                    output_root=output_root,
                    bundle_id=args.joint_bundle_id,
                    ranking_model_root=ranking_model_root,
                    quant_model_root=quant_model_root,
                    position_model_root=position_model_root,
                    account_backtest_path=account_parent
                    / args.account_backtest.name,
                    agent_model=settings().agent_model,
                ),
                ensure_ascii=False,
            )
        )
    elif args.command == "publish-joint-shadow":
        from platform_app.modules.experiments.joint_bundle import (
            publish_shadow_release,
        )

        if not all(
            (
                args.candidate_root,
                args.registry_root,
                args.release_id,
                args.ranking_model_root,
                args.model_root,
                args.position_model_root,
                args.account_backtest,
            )
        ):
            parser.error(
                "candidate-root, registry-root, release-id, ranking-model-root, "
                "model-root, position-model-root and account-backtest are required"
            )
        try:
            candidate_root = external_dataset_root(args.candidate_root)
            registry_root = external_dataset_root(args.registry_root)
            ranking_model_root = external_dataset_root(args.ranking_model_root)
            quant_model_root = external_dataset_root(args.model_root)
            position_model_root = external_dataset_root(args.position_model_root)
            account_parent = external_dataset_root(
                args.account_backtest.resolve().parent
            )
        except ValueError as exc:
            parser.error(str(exc))
        print(
            json.dumps(
                publish_shadow_release(
                    candidate_root=candidate_root,
                    registry_root=registry_root,
                    release_id=args.release_id,
                    ranking_model_root=ranking_model_root,
                    quant_model_root=quant_model_root,
                    position_model_root=position_model_root,
                    account_backtest_path=account_parent
                    / args.account_backtest.name,
                ),
                ensure_ascii=False,
            )
        )
    elif args.command == "run-daily-joint-cycle":
        from platform_app.modules.experiments.daily_joint_cycle import (
            write_daily_joint_cycle,
        )

        if not all(
            (
                args.registry_root,
                args.dataset_root,
                args.account_backtest,
                args.output,
            )
        ):
            parser.error(
                "registry-root, dataset-root, account-backtest and output "
                "are required"
            )
        try:
            registry_root = external_dataset_root(args.registry_root)
            dataset_root = external_dataset_root(args.dataset_root)
            output_root = external_dataset_root(args.output)
            account_parent = external_dataset_root(
                args.account_backtest.resolve().parent
            )
        except ValueError as exc:
            parser.error(str(exc))
        print(
            json.dumps(
                write_daily_joint_cycle(
                    output_root=output_root,
                    active_release_pointer=registry_root
                    / "active-shadow.json",
                    market_dataset_root=dataset_root,
                    account_backtest_path=account_parent
                    / args.account_backtest.name,
                    minimum_matured_samples=args.minimum_matured_samples,
                ),
                ensure_ascii=False,
            )
        )
    elif args.command == "evaluate-account-backtest":
        from platform_app.modules.experiments.account_backtest import (
            write_account_backtest,
        )

        if not all(
            (
                args.quant_backtest,
                args.dataset_root,
                args.ranking_root,
                args.model_root,
                args.episode_root,
                args.label_root,
                args.output,
            )
        ):
            parser.error(
                "quant-backtest, dataset-root, ranking-root, model-root, "
                "episode-root, label-root and output are required"
            )
        try:
            market_root = external_dataset_root(args.dataset_root)
            ranking_root = external_dataset_root(args.ranking_root)
            model_root = external_dataset_root(args.model_root)
            episode_root = external_dataset_root(args.episode_root)
            label_root = external_dataset_root(args.label_root)
            backtest_parent = external_dataset_root(
                args.quant_backtest.resolve().parent
            )
            output_parent = external_dataset_root(args.output.resolve().parent)
        except ValueError as exc:
            parser.error(str(exc))
        report = write_account_backtest(
            quant_backtest_path=backtest_parent / args.quant_backtest.name,
            market_dataset_root=market_root,
            ranking_dataset_root=ranking_root,
            quant_model_root=model_root,
            episode_dataset_root=episode_root,
            label_dataset_root=label_root,
            output_path=output_parent / args.output.name,
        )
        print(
            json.dumps(
                {
                    "output": str((output_parent / args.output.name).resolve()),
                    "releaseStatus": report["releaseStatus"],
                    "releaseBlockers": report["releaseBlockers"],
                    "accountScenarios": [
                        {
                            key: value
                            for key, value in scenario.items()
                            if key
                            in {
                                "initialCashCny",
                                "finalCashCny",
                                "stressFinalCashCny",
                                "netReturn",
                                "stressNetReturn",
                                "maximumDrawdown",
                                "stressMaximumDrawdown",
                                "maxConcurrentPositions",
                                "counts",
                            }
                        }
                        for scenario in report["accountScenarios"]
                    ],
                },
                ensure_ascii=False,
            )
        )
    elif args.command == "evaluate-quant-backtest":
        from platform_app.modules.experiments.quant_execution_backtest import (
            write_quant_execution_backtest,
        )

        if not all(
            (
                args.coverage_report,
                args.ranking_root,
                args.model_root,
                args.label_root,
                args.output,
            )
        ):
            parser.error(
                "coverage-report, ranking-root, model-root, label-root and output "
                "are required"
            )
        try:
            ranking_root = external_dataset_root(args.ranking_root)
            model_root = external_dataset_root(args.model_root)
            label_root = external_dataset_root(args.label_root)
            coverage_parent = external_dataset_root(
                args.coverage_report.resolve().parent
            )
            output_parent = external_dataset_root(args.output.resolve().parent)
        except ValueError as exc:
            parser.error(str(exc))
        report = write_quant_execution_backtest(
            coverage_audit_path=coverage_parent / args.coverage_report.name,
            ranking_dataset_root=ranking_root,
            quant_model_root=model_root,
            label_dataset_root=label_root,
            output_path=output_parent / args.output.name,
        )
        print(
            json.dumps(
                {
                    "output": str((output_parent / args.output.name).resolve()),
                    "releaseStatus": report["releaseStatus"],
                    "releaseBlockers": report["releaseBlockers"],
                    "coverage": report["coverage"],
                    "rankingOnlyCovered": report["rankingOnlyCovered"],
                    "modelActionable": report["modelActionable"],
                },
                ensure_ascii=False,
            )
        )
    elif args.command == "train-position-action-model":
        from platform_app.modules.experiments.position_action_model import (
            load_position_action_training_data,
            write_position_action_bundle,
        )

        if not all(
            (
                args.position_root,
                args.ranking_root,
                args.model_root,
                args.model_bundle_id,
            )
        ):
            parser.error(
                "position-root, ranking-root, model-root and model-bundle-id "
                "are required"
            )
        try:
            position_root = external_dataset_root(args.position_root)
            ranking_root = external_dataset_root(args.ranking_root)
            model_root = external_dataset_root(args.model_root)
        except ValueError as exc:
            parser.error(str(exc))
        data, lineage = load_position_action_training_data(
            position_dataset_root=position_root,
            ranking_dataset_root=ranking_root,
        )
        print(
            json.dumps(
                write_position_action_bundle(
                    output_root=model_root,
                    bundle_id=args.model_bundle_id,
                    data=data,
                    lineage=lineage,
                    max_iter=args.max_iterations,
                ),
                ensure_ascii=False,
            )
        )
    elif args.command == "audit-execution-coverage":
        from platform_app.modules.experiments.execution_backtest import (
            write_execution_coverage_audit,
        )

        if not all(
            (
                args.ranking_root,
                args.model_root,
                args.episode_root,
                args.label_root,
                args.output,
            )
        ):
            parser.error(
                "ranking-root, model-root, episode-root, label-root and output "
                "are required"
            )
        try:
            ranking_root = external_dataset_root(args.ranking_root)
            model_root = external_dataset_root(args.model_root)
            episode_root = external_dataset_root(args.episode_root)
            label_root = external_dataset_root(args.label_root)
            output_parent = external_dataset_root(args.output.resolve().parent)
        except ValueError as exc:
            parser.error(str(exc))
        report = write_execution_coverage_audit(
            ranking_dataset_root=ranking_root,
            ranking_model_root=model_root,
            episode_dataset_root=episode_root,
            label_dataset_root=label_root,
            output_path=output_parent / args.output.name,
            top_n=args.top_n,
        )
        print(
            json.dumps(
                {
                    "output": str((output_parent / args.output.name).resolve()),
                    "complete": report["complete"],
                    "releaseBlockers": report["releaseBlockers"],
                    "coverage": report["coverage"],
                },
                ensure_ascii=False,
            )
        )
    elif args.command == "train-ranking-model":
        from platform_app.modules.experiments.ranking_model_trainer import (
            load_ranking_training_data,
            write_ranking_bundle,
        )

        if not all(
            (
                args.ranking_root,
                args.model_root,
                args.model_bundle_id,
            )
        ):
            parser.error("ranking-root, model-root and model-bundle-id are required")
        try:
            ranking_root = external_dataset_root(args.ranking_root)
            model_root = external_dataset_root(args.model_root)
        except ValueError as exc:
            parser.error(str(exc))
        data, ranking_manifest = load_ranking_training_data(ranking_root)
        print(
            json.dumps(
                write_ranking_bundle(
                    output_root=model_root,
                    bundle_id=args.model_bundle_id,
                    data=data,
                    ranking_manifest=ranking_manifest,
                    max_iter=args.max_iterations,
                ),
                ensure_ascii=False,
            )
        )
    elif args.command == "train-quant-model":
        from platform_app.modules.experiments.quant_model_trainer import (
            load_enriched_training_data,
            load_training_data,
            write_quant_bundle,
        )

        if not all(
            (
                args.episode_root,
                args.label_root,
                args.model_root,
                args.model_bundle_id,
            )
        ):
            parser.error(
                "episode-root, label-root, model-root and model-bundle-id are required"
            )
        try:
            episode_root = external_dataset_root(args.episode_root)
            label_root = external_dataset_root(args.label_root)
            model_root = external_dataset_root(args.model_root)
        except ValueError as exc:
            parser.error(str(exc))
        if args.ranking_root:
            data, lineage = load_enriched_training_data(
                episode_dataset_root=episode_root,
                label_dataset_root=label_root,
                ranking_dataset_root=external_dataset_root(args.ranking_root),
            )
        else:
            data, lineage = load_training_data(
                episode_dataset_root=episode_root,
                label_dataset_root=label_root,
            )
        print(
            json.dumps(
                write_quant_bundle(
                    output_root=model_root,
                    bundle_id=args.model_bundle_id,
                    data=data,
                    lineage=lineage,
                    max_iter=args.max_iterations,
                ),
                ensure_ascii=False,
            )
        )
    elif args.command == "build-ranking-dataset":
        from platform_app.modules.experiments.ranking_dataset import RankingDataset

        if not all(
            (
                args.dataset_root,
                args.ranking_root,
                args.ranking_dataset_id,
                args.start_date,
                args.end_date,
                args.stage,
            )
        ):
            parser.error(
                "dataset-root, ranking-root, ranking-dataset-id, dates and stage are required"
            )
        if args.stage not in {"ranking-samples", "seal"}:
            parser.error("ranking dataset stage must be ranking-samples or seal")
        if (
            not re.fullmatch(r"\d{8}", args.start_date)
            or not re.fullmatch(r"\d{8}", args.end_date)
            or args.start_date > args.end_date
        ):
            parser.error("ranking dataset requires ordered YYYYMMDD date values")
        try:
            market_root = external_dataset_root(args.dataset_root)
            ranking_root = external_dataset_root(args.ranking_root)
        except ValueError as exc:
            parser.error(str(exc))
        with RankingDataset(
            ranking_root,
            dataset_id=args.ranking_dataset_id,
            market_dataset_root=market_root,
            start_date=args.start_date,
            end_date=args.end_date,
        ) as dataset:
            if args.stage == "seal":
                print(json.dumps(dataset.seal(), ensure_ascii=False))
            else:
                for result in dataset.build(max_instruments=args.max_windows):
                    print(json.dumps(result, ensure_ascii=False), flush=True)
    elif args.command == "build-position-action-dataset":
        from platform_app.modules.experiments.position_action_dataset import (
            PositionActionDataset,
        )

        if not all(
            (
                args.dataset_root,
                args.episode_root,
                args.label_root,
                args.position_root,
                args.position_dataset_id,
                args.stage,
            )
        ):
            parser.error(
                "dataset-root, episode-root, label-root, position-root, "
                "position-dataset-id and stage are required"
            )
        if args.stage not in {"labels", "seal"}:
            parser.error("position action stage must be labels or seal")
        if args.stage == "labels" and (
            not args.start_date
            or not args.end_date
            or not re.fullmatch(r"\d{8}", args.start_date)
            or not re.fullmatch(r"\d{8}", args.end_date)
            or args.start_date > args.end_date
        ):
            parser.error("labels stage requires ordered YYYYMMDD date values")
        try:
            market_root = external_dataset_root(args.dataset_root)
            episode_root = external_dataset_root(args.episode_root)
            label_root = external_dataset_root(args.label_root)
            position_root = external_dataset_root(args.position_root)
        except ValueError as exc:
            parser.error(str(exc))
        with PositionActionDataset(
            position_root,
            dataset_id=args.position_dataset_id,
            episode_dataset_root=episode_root,
            label_dataset_root=label_root,
            market_dataset_root=market_root,
        ) as dataset:
            if args.stage == "seal":
                print(json.dumps(dataset.seal(), ensure_ascii=False))
            else:
                for result in dataset.build_range(args.start_date, args.end_date):
                    print(json.dumps(result, ensure_ascii=False), flush=True)
    elif args.command == "build-selected-backtest-dataset":
        from platform_app.modules.experiments.episode_dataset import EpisodeDataset
        from platform_app.modules.experiments.minute_requirement_fetcher import (
            MinuteRequirementFetcher,
        )
        from platform_app.modules.experiments.minute_requirement_builder import (
            MinuteRequirementBuilder,
        )
        from platform_app.modules.experiments.selected_episode_builder import (
            SelectedEpisodeBuilder,
            load_selected_backtest_policy,
        )

        if not all(
            (
                args.dataset_root,
                args.episode_root,
                args.episode_dataset_id,
                args.ranking_root,
                args.model_root,
                args.stage,
            )
        ):
            parser.error(
                "dataset-root, episode-root, episode-dataset-id, ranking-root, "
                "model-root and stage are required"
            )
        if args.stage not in {
            "candidates",
            "minute-requirements",
            "fetch-minutes",
            "exhaust-minutes",
            "seal",
        }:
            parser.error(
                "selected backtest stage must be candidates, minute-requirements, "
                "fetch-minutes, exhaust-minutes or seal"
            )
        if args.stage != "seal" and (
            not args.start_date
            or not args.end_date
            or not re.fullmatch(r"\d{8}", args.start_date)
            or not re.fullmatch(r"\d{8}", args.end_date)
            or args.start_date > args.end_date
        ):
            parser.error("non-seal stages require ordered YYYYMMDD date values")
        if args.stage == "exhaust-minutes" and (
            not args.reason or not args.resolution_note
        ):
            parser.error("exhaust-minutes stage requires reason and resolution-note")
        if args.stage == "fetch-minutes" and args.max_sessions > 150:
            parser.error("fetch-minutes requires max-sessions <= 150")
        try:
            market_root = external_dataset_root(args.dataset_root)
            episode_root = external_dataset_root(args.episode_root)
            ranking_root = external_dataset_root(args.ranking_root)
            model_root = external_dataset_root(args.model_root)
        except ValueError as exc:
            parser.error(str(exc))
        policy = load_selected_backtest_policy(
            ranking_dataset_root=ranking_root,
            ranking_model_root=model_root,
            top_n=args.top_n,
        )
        with EpisodeDataset(
            episode_root,
            dataset_id=args.episode_dataset_id,
            market_dataset_root=market_root,
            policy=policy,
        ) as dataset:
            if args.stage == "seal":
                print(json.dumps(dataset.seal(), ensure_ascii=False))
            elif args.stage == "exhaust-minutes":
                print(
                    json.dumps(
                        dataset.resolve_exhausted_minutes(
                            start_date=args.start_date,
                            end_date=args.end_date,
                            reasons=args.reason,
                            note=args.resolution_note,
                        ),
                        ensure_ascii=False,
                    )
                )
            elif args.stage == "minute-requirements":
                with MinuteRequirementBuilder(dataset) as builder:
                    results = builder.build_range(args.start_date, args.end_date)
                for result in results:
                    print(json.dumps(result, ensure_ascii=False), flush=True)
            elif args.stage == "fetch-minutes":
                from platform_app.adapters.market_tushare import TushareClient

                with MinuteRequirementFetcher(
                    TushareClient(),
                    dataset,
                    max_sessions=args.max_sessions,
                ) as fetcher:
                    for result in fetcher.fetch_pending(
                        args.start_date,
                        args.end_date,
                        reasons=args.reason,
                        max_windows=args.max_windows,
                    ):
                        print(json.dumps(result, ensure_ascii=False), flush=True)
            else:
                builder = SelectedEpisodeBuilder(
                    dataset,
                    ranking_dataset_root=ranking_root,
                    ranking_model_root=model_root,
                    top_n=args.top_n,
                )
                for result in builder.build_range(args.start_date, args.end_date):
                    print(json.dumps(result, ensure_ascii=False), flush=True)
    elif args.command == "build-label-dataset":
        from platform_app.modules.experiments.label_dataset import LabelDataset

        if not all(
            (
                args.dataset_root,
                args.episode_root,
                args.label_root,
                args.label_dataset_id,
                args.stage,
            )
        ):
            parser.error(
                "dataset-root, episode-root, label-root, label-dataset-id and stage are required"
            )
        if args.stage not in {"labels", "seal"}:
            parser.error("label dataset stage must be labels or seal")
        if args.stage == "labels" and (
            not args.start_date
            or not args.end_date
            or not re.fullmatch(r"\d{8}", args.start_date)
            or not re.fullmatch(r"\d{8}", args.end_date)
            or args.start_date > args.end_date
        ):
            parser.error("labels stage requires ordered YYYYMMDD date values")
        try:
            market_root = external_dataset_root(args.dataset_root)
            episode_root = external_dataset_root(args.episode_root)
            label_root = external_dataset_root(args.label_root)
        except ValueError as exc:
            parser.error(str(exc))
        with LabelDataset(
            label_root,
            dataset_id=args.label_dataset_id,
            episode_dataset_root=episode_root,
            market_dataset_root=market_root,
        ) as dataset:
            if args.stage == "seal":
                print(json.dumps(dataset.seal(), ensure_ascii=False))
            else:
                for result in dataset.build_range(args.start_date, args.end_date):
                    print(json.dumps(result, ensure_ascii=False), flush=True)
    elif args.command == "build-episode-dataset":
        from platform_app.modules.experiments.candidate_episode_builder import (
            CandidateEpisodeBuilder,
        )
        from platform_app.modules.experiments.episode_dataset import EpisodeDataset
        from platform_app.modules.experiments.minute_archive_importer import (
            MinuteArchiveImporter,
        )
        from platform_app.modules.experiments.minute_requirement_fetcher import (
            MinuteRequirementFetcher,
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
            "fetch-minutes",
            "exhaust-minutes",
            "seal",
        }:
            parser.error(
                "episode dataset stage must be candidates, minute-requirements, "
                "archive-minutes, fetch-minutes, exhaust-minutes or seal"
            )
        if args.stage in {
            "candidates",
            "minute-requirements",
            "archive-minutes",
            "fetch-minutes",
            "exhaust-minutes",
        } and (
            not args.start_date
            or not args.end_date
            or not re.fullmatch(r"\d{8}", args.start_date)
            or not re.fullmatch(r"\d{8}", args.end_date)
            or args.start_date > args.end_date
        ):
            parser.error("candidates stage requires ordered YYYYMMDD date values")
        if args.stage == "archive-minutes" and not args.archive_root:
            parser.error("archive-minutes stage requires archive-root")
        if args.stage == "exhaust-minutes" and (
            not args.reason or not args.resolution_note
        ):
            parser.error("exhaust-minutes stage requires reason and resolution-note")
        if args.stage == "fetch-minutes" and (
            args.max_sessions > 150
            or (
                args.instrument_id
                and (
                    len(args.instrument_id) != len(set(args.instrument_id))
                    or any(
                        not re.fullmatch(r"(SH|SZ|BJ)\.\d{6}", value)
                        for value in args.instrument_id
                    )
                )
            )
        ):
            parser.error(
                "fetch-minutes requires max-sessions <= 150 and unique valid instrument IDs"
            )
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
            elif args.stage == "exhaust-minutes":
                print(
                    json.dumps(
                        dataset.resolve_exhausted_minutes(
                            start_date=args.start_date,
                            end_date=args.end_date,
                            reasons=args.reason,
                            note=args.resolution_note,
                        ),
                        ensure_ascii=False,
                    )
                )
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
            elif args.stage == "fetch-minutes":
                from platform_app.adapters.market_tushare import TushareClient

                with MinuteRequirementFetcher(
                    TushareClient(),
                    dataset,
                    max_sessions=args.max_sessions,
                ) as fetcher:
                    for result in fetcher.fetch_pending(
                        args.start_date,
                        args.end_date,
                        instrument_ids=args.instrument_id,
                        reasons=args.reason,
                        max_windows=args.max_windows,
                    ):
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
