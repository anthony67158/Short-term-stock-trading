"""Build minute paths for the union of strictly held-out model selections."""

import argparse
import copy
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

from platform_app.adapters.market_tushare import TushareClient
from platform_app.modules.experiments.daily_ranking_sample import FEATURE_SCHEMA_VERSION
from platform_app.modules.experiments.episode_dataset import EpisodeDataset, EpisodeDatasetError
from platform_app.modules.experiments.minute_archive_importer import ingest_minute_requirement
from platform_app.modules.experiments.minute_requirement_builder import MinuteRequirementBuilder
from platform_app.modules.experiments.minute_requirement_fetcher import MinuteRequirementFetcher
from platform_app.modules.experiments.ranking_model_trainer import (
    RAW_COLUMNS, _file_sha256, _verified_ranking_database,
)
from platform_app.modules.experiments.selected_episode_builder import _partition_payload
from platform_app.modules.experiments.short_horizon_policy import SHORT_HORIZON_POLICY


def union_policy(experiment: Path, ranking_manifest: dict) -> dict:
    protocol = json.loads((experiment / "protocol.json").read_text())
    if protocol["databaseSha256"] != ranking_manifest["databaseSha256"]:
        raise EpisodeDatasetError("COMBINATION_RANKING_LINEAGE_MISMATCH")
    policy = copy.deepcopy(SHORT_HORIZON_POLICY)
    policy.update({
        "policyVersion": "combination-oof-union.v1",
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "candidatePolicy": {
            "selection": "UNION_OF_EACH_MODEL_OOF_TOP10",
            "tieBreak": "LOADER_BOARD_INSTRUMENT_ORDER_LAST_TEN",
            "rankingDatasetId": ranking_manifest["datasetId"],
            "rankingDatabaseSha256": ranking_manifest["databaseSha256"],
            "experimentProtocolSha256": _file_sha256(experiment / "protocol.json"),
            "evaluationUse": "DEVELOPMENT_NOT_INDEPENDENT_CONFIRMATION",
        },
    })
    return policy


def build_candidates(dataset, experiment, ranking_path):
    columns = ", ".join((
        "instrument_id", "board", "execution_date", "feature_available_at", *RAW_COLUMNS,
    ))
    with sqlite3.connect(f"{ranking_path.as_uri()}?mode=ro&immutable=1", uri=True) as ranking:
        ranking.row_factory = sqlite3.Row
        for path in sorted(experiment.glob("fold-*/candidate-union.json")):
            by_date = defaultdict(list)
            evaluation = json.loads((path.parent / "evaluation.json").read_text())
            split = evaluation["split"]
            for row in json.loads(path.read_text())["candidates"]:
                if not int(split["testStart"]) <= int(row["decisionDate"]) <= int(split["testEnd"]):
                    raise EpisodeDatasetError("COMBINATION_SELECTION_OUTSIDE_TEST")
                by_date[row["decisionDate"]].append(row)
            for date, candidates in sorted(by_date.items()):
                candidates.sort(key=lambda row: row["instrumentId"])
                selections = [
                    {**row, "rankPosition": index + 1, "rankScore": 0.0}
                    for index, row in enumerate(candidates)
                ]
                rows = [dict(row) for row in ranking.execute(
                    f"SELECT {columns} FROM ranking_samples "
                    "WHERE decision_date=? ORDER BY instrument_id", (date,),
                )]
                payload = _partition_payload(
                    decision_date=date, selections=selections, universe_rows=rows,
                    feature_schema_version=FEATURE_SCHEMA_VERSION,
                )
                for row in payload["candidates"]:
                    row["sampleBucket"] = "COMBINATION_OOF_UNION"
                for row in payload["rejections"]:
                    row["reason"] = "NOT_IN_COMBINATION_OOF_UNION"
                dataset.write_candidate_partition(**payload)
            print(json.dumps({"fold": path.parent.name, "candidateDates": len(by_date)}), flush=True)


def reuse_minutes(dataset, archive_root):
    manifest = json.loads((archive_root / "manifest.json").read_text())
    source = archive_root / manifest["database"]
    if (
        _file_sha256(source) != manifest["databaseSha256"]
        or manifest["marketDatabaseSha256"] != dataset.db.execute(
            "SELECT market_database_sha256 FROM episode_dataset_metadata"
        ).fetchone()[0]
    ):
        raise EpisodeDatasetError("COMBINATION_ARCHIVE_LINEAGE_MISMATCH")
    with sqlite3.connect(f"{source.as_uri()}?mode=ro&immutable=1", uri=True) as archive:
        archive.row_factory = sqlite3.Row
        with MinuteRequirementBuilder(dataset) as builder:
            pending = dataset.db.execute(
                "SELECT instrument_id,trade_date FROM minute_requirements WHERE status='PENDING'"
            ).fetchall()
            accepted = 0
            for requirement in pending:
                instrument, date = requirement
                records = archive.execute(
                    "SELECT * FROM episode_minute_bars WHERE instrument_id=? AND trade_date=? "
                    "ORDER BY bar_end_shanghai", (instrument, date),
                ).fetchall()
                if not records:
                    continue
                bars = [{
                    "instrumentId": instrument, "tradeDate": date,
                    "barEndShanghai": r["bar_end_shanghai"],
                    **{key: r[key] for key in ("open", "high", "low", "close")},
                    "volumeShares": r["volume_shares"], "amountCny": r["amount_cny"],
                    "sourceRowSha256": r["source_row_sha256"],
                } for r in records]
                with dataset.db:
                    result = ingest_minute_requirement(
                        dataset, builder.market, instrument_id=instrument, trade_date=date,
                        rows=bars, source_kind="SEALED_EPISODE_REUSE_V1",
                        source_asset_sha256=manifest["databaseSha256"],
                    )
                accepted += result["outcome"] == "ACCEPTED"
            print(json.dumps({"reusedMinuteSessions": accepted}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ("experiment", "ranking-root", "market-root", "output"):
        parser.add_argument(f"--{arg}", type=Path, required=True)
    parser.add_argument("--reuse", type=Path)
    parser.add_argument("--fetch-windows", type=int, default=0)
    args = parser.parse_args()
    manifest, ranking = _verified_ranking_database(args.ranking_root)
    with EpisodeDataset(
        args.output, dataset_id=args.output.name, market_dataset_root=args.market_root,
        policy=union_policy(args.experiment, manifest),
    ) as dataset:
        build_candidates(dataset, args.experiment, ranking)
        with MinuteRequirementBuilder(dataset) as builder:
            builder.build_range("20160101", "20991231")
        if args.reuse:
            reuse_minutes(dataset, args.reuse)
        if args.fetch_windows:
            with MinuteRequirementFetcher(TushareClient(), dataset) as fetcher:
                for result in fetcher.fetch_pending(
                    "20160101", "20991231", max_windows=args.fetch_windows,
                ):
                    print(json.dumps(result), flush=True)
        print(json.dumps({
            "minuteRequirements": dict(dataset.db.execute(
                "SELECT status,count(*) FROM minute_requirements GROUP BY status"
            ).fetchall()),
            "episodes": dataset.db.execute("SELECT count(*) FROM candidate_episodes").fetchone()[0],
        }), flush=True)


if __name__ == "__main__":
    main()
