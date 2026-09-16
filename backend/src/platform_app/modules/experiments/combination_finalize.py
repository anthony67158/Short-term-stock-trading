"""Single-writer repair, seal, label and evaluate a completed OOF candidate union."""

import argparse
import fcntl
import json
import os
import time
from pathlib import Path

import httpx

from platform_app.adapters.market_tushare import TushareClient
from platform_app.modules.experiments.combination_episodes import union_policy
from platform_app.modules.experiments.combination_fee_comparison import run as compare_fees
from platform_app.modules.experiments.episode_dataset import EpisodeDataset
from platform_app.modules.experiments.execution_walk_forward import run as train_execution
from platform_app.modules.experiments.label_dataset import LabelDataset
from platform_app.modules.experiments.minute_requirement_fetcher import MinuteRequirementFetcher
from platform_app.modules.experiments.ranking_model_trainer import _verified_ranking_database


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def fetch_with_transport_retry(fetcher, window, *, attempts=3, sleep=time.sleep):
    for attempt in range(1, attempts + 1):
        try:
            return fetcher.fetch_window(window)
        except httpx.TransportError:
            if attempt == attempts:
                raise
            emit({
                "stage": "MINUTE_TRANSPORT_RETRY",
                "instrumentId": window["instrumentId"],
                "attempt": attempt,
            })
            sleep(attempt)
    raise AssertionError("unreachable")


def finalize(args):
    if args.prior_writer_pid:
        try:
            os.kill(args.prior_writer_pid, 0)
        except ProcessLookupError:
            pass
        else:
            raise ValueError("PRIOR_MINUTE_WRITER_STILL_RUNNING")
    manifest, _ = _verified_ranking_database(args.ranking_root)
    splits = json.loads((args.experiment / "splits.json").read_text())["folds"]
    paths = sorted(args.experiment.glob("fold-*/candidate-union.json"))
    if len(paths) != len(splits):
        raise ValueError("COMBINATION_FOLDS_INCOMPLETE")
    expected_dates = {
        r["decisionDate"] for path in paths
        for r in json.loads(path.read_text())["candidates"]
    }
    if not (args.episode_root / "manifest.json").exists():
        with EpisodeDataset(
            args.episode_root, dataset_id=args.episode_root.name,
            market_dataset_root=args.market_root, policy=union_policy(args.experiment, manifest),
        ) as dataset:
            actual_dates = {r[0] for r in dataset.db.execute(
                "SELECT decision_date FROM candidate_partitions",
            )}
            if actual_dates != expected_dates:
                raise ValueError("COMBINATION_CANDIDATE_DATES_INCOMPLETE")
            # Retry all outstanding dates, overriding only an explicit current code mapping.
            with MinuteRequirementFetcher(TushareClient(), dataset) as fetcher:
                windows = fetcher.pending_windows("20160101", "20991231")
                canonical = dict(fetcher.market.execute(
                    "SELECT instrument_id,source_code FROM instruments",
                ).fetchall())
                for window in windows:
                    retry = {**window, "sourceCode": canonical[window["instrumentId"]]}
                    emit(fetch_with_transport_retry(fetcher, retry))
            # A second bounded request isolates mismatched sessions from long-window responses.
            # This remains real source retrieval; never relax OHLC/volume/day matching.
            with MinuteRequirementFetcher(TushareClient(), dataset, max_sessions=1) as fetcher:
                windows = fetcher.pending_windows("20160101", "20991231")
                for window in windows:
                    retry = {**window, "sourceCode": canonical[window["instrumentId"]]}
                    emit(fetch_with_transport_retry(fetcher, retry))
            pending = dataset.db.execute(
                "SELECT reason,count(*) FROM minute_requirements "
                "WHERE status='PENDING' GROUP BY reason",
            ).fetchall()
            reasons = [row[0] for row in pending]
            if None in reasons:
                raise ValueError("UNATTEMPTED_MINUTE_REQUIREMENTS_REMAIN")
            if reasons:
                emit(dataset.resolve_exhausted_minutes(
                    start_date="20160101", end_date="20991231", reasons=reasons,
                    note=(
                        "Research snapshot: initial retrieval plus canonical-code window and "
                        "single-session retries exhausted this provider. Missing paths remain "
                        "unavailable; this is not complete market coverage or release approval."
                    ),
                ))
            emit({"episodeManifest": dataset.seal()})
    if not (args.label_root / "manifest.json").exists():
        with LabelDataset(
            args.label_root, dataset_id=args.label_root.name,
            episode_dataset_root=args.episode_root, market_dataset_root=args.market_root,
        ) as labels:
            for result in labels.build_range("20160101", "20991231"):
                emit(result)
            emit({"labelManifest": labels.seal()})
    compare_fees(args.experiment, args.label_root, args.experiment / "fee-comparison.json")
    if not args.execution_output.exists():
        train_execution(args.episode_root, args.label_root, args.ranking_root, args.execution_output)
    evaluation_path = args.execution_output / "evaluation.json"
    if not evaluation_path.exists() or json.loads(evaluation_path.read_text())["completedFolds"] != 5:
        raise ValueError("EXECUTION_RUN_INCOMPLETE_USE_NEW_OUTPUT")
    emit({"stage": "RESEARCH_EXECUTION_EVALUATED", "releaseStatus": "UNAVAILABLE"})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("experiment", "episode-root", "label-root", "ranking-root", "market-root",
                 "execution-output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--prior-writer-pid", type=int)
    parser.add_argument("--wait-for-prior-writer", action="store_true")
    args = parser.parse_args()
    with (args.experiment / "finalize.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.wait_for_prior_writer and args.prior_writer_pid:
            deadline = time.monotonic() + 4 * 60 * 60
            emit({"stage": "WAITING_FOR_PRIOR_WRITER", "pid": args.prior_writer_pid})
            while time.monotonic() < deadline:
                try:
                    os.kill(args.prior_writer_pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(10)
            else:
                raise ValueError("PRIOR_WRITER_WAIT_EXCEEDED")
        finalize(args)


if __name__ == "__main__":
    main()
