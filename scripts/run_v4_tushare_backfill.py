#!/usr/bin/env python3
"""Resumable five-year Tushare minute backfill for V4 causal replay.

Each chunk contains:
  - 60 history sessions used only to construct point-in-time features;
  - up to 145 signal sessions;
  - 7 settlement sessions.

The 152-day minute request stays below Tushare's 8,000-row per-stock limit at
5-minute frequency. Every chunk has isolated SQLite/cache state so resuming or
retrying one range cannot delete another range's data.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import gzip
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = Path.home() / ".tushare-v4-5y"
CONTRACT_ROOT = ROOT / "qlib-service" / "contracts"


def _contract(name):
    with open(CONTRACT_ROOT / name, encoding="utf-8") as handle:
        return json.load(handle)


_V4_CONTRACT = _contract("opportunity-review-features-v4.json")
_BASE_CONTRACT = _contract(_V4_CONTRACT["baseFeatureContract"])
_INITIAL_CONTRACT = _contract(_V4_CONTRACT["initialFeatureContract"])
_ALPHA_CONTRACT = _contract(_V4_CONTRACT["alphaFeatureContract"])
V4_FEATURE_SCHEMA = _V4_CONTRACT["featureSchemaVersion"]
V4_FEATURE_NAMES = tuple([
    *_BASE_CONTRACT["featureNames"],
    *[
        f"{_V4_CONTRACT['initialFeaturePrefix']}{name}"
        for name in _INITIAL_CONTRACT["featureNames"]
    ],
    *[
        f"{_V4_CONTRACT['alphaFeaturePrefix']}{name}"
        for name in _ALPHA_CONTRACT["featureNames"]
    ],
])


@contextlib.contextmanager
def _exclusive_run_lock(output):
    directory = Path(output).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / ".backfill.lock"
    handle = open(path, "a+", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        handle.close()
        raise RuntimeError(
            f"已有历史回填进程占用目录: {directory}"
        ) from error
    try:
        handle.seek(0)
        handle.truncate()
        handle.write(f"{os.getpid()}\n")
        handle.flush()
        yield
    finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def _read_gzip(path):
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def _write_gzip(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".part")
    with gzip.open(
        temporary,
        "wt",
        encoding="utf-8",
        compresslevel=6,
    ) as handle:
        json.dump(
            value,
            handle,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def build_chunk_plan(
    dates,
    *,
    history_days=60,
    signal_days=145,
    settlement_days=7,
    minimum_signal_days=60,
):
    ordered = sorted(set(str(value) for value in dates))
    eligible = ordered[history_days:len(ordered) - settlement_days]
    signal_chunks = [
        eligible[offset:offset + signal_days]
        for offset in range(0, len(eligible), signal_days)
    ]
    if (
        len(signal_chunks) > 1
        and len(signal_chunks[-1]) < minimum_signal_days
    ):
        combined = signal_chunks[-2] + signal_chunks[-1]
        maximum_signal_days = 160 - settlement_days
        if len(combined) <= maximum_signal_days:
            signal_chunks[-2:] = [combined]
        else:
            split = len(combined) // 2
            left, right = combined[:split], combined[split:]
            if min(len(left), len(right)) < minimum_signal_days:
                raise ValueError("无法生成满足最小信号日要求的分片")
            signal_chunks[-2:] = [left, right]

    chunks = []
    for signals in signal_chunks:
        first = ordered.index(signals[0])
        last = ordered.index(signals[-1])
        chunks.append({
            "index": len(chunks) + 1,
            "from": ordered[first - history_days],
            "to": ordered[last + settlement_days],
            "signalFrom": signals[0],
            "signalTo": signals[-1],
            "signalDays": len(signals),
        })
    return chunks


def _run(command, log_path, *, allow_failure=False):
    log_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(log_path, "a", encoding="utf-8") as log:
        result = subprocess.run(
            command,
            cwd=ROOT,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )
    if result.returncode and not allow_failure:
        raise RuntimeError(
            f"命令失败({result.returncode})，查看 {log_path}"
        )
    return result.returncode


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _alpha_snapshot_sha256(args):
    cached = getattr(args, "_alpha_snapshot_sha256", None)
    if cached:
        return cached
    path = Path(args.alpha_snapshot).expanduser().resolve()
    if not path.is_file():
        raise RuntimeError(f"缺少无前视Alpha快照: {path}")
    digest = _sha256_file(path)
    setattr(args, "_alpha_snapshot_sha256", digest)
    return digest


def _v4_cache_matches_alpha(args, directory):
    outcome = directory / "opportunity-outcomes-v4.json.gz"
    report = directory / "v4-report.json"
    if not outcome.is_file() or not report.is_file():
        return False
    try:
        with open(report, encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return False
    return (
        payload.get("alphaSnapshotSha256")
        == _alpha_snapshot_sha256(args)
    )


def _write_chunk_audit(directory):
    minute_files = sorted((directory / "minutes").glob("*.json.gz"))
    required = [
        directory / "daily.json.gz",
        directory / "funds.json.gz",
        directory / "minute-manifest.json",
        directory / "opportunity-outcomes-combined.json",
        directory / "opportunity-outcomes-v4.json.gz",
        *minute_files,
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise RuntimeError(f"分片审计缺少文件: {missing[:3]}")
    audit = {
        "schemaVersion": "v4-tushare-chunk-audit.v1",
        "files": [
            {
                "path": str(path.relative_to(directory)),
                "size": path.stat().st_size,
                "sha256": _sha256_file(path),
            }
            for path in required
        ],
    }
    destination = directory / "audit.json"
    temporary = destination.with_suffix(".json.part")
    temporary.write_text(
        json.dumps(audit, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    os.replace(temporary, destination)


def _prepare_chunks(args):
    output = Path(args.output).expanduser().resolve()
    plan_path = output / "plan.json"
    if plan_path.is_file() and not getattr(args, "refresh_plan", False):
        with open(plan_path, encoding="utf-8") as handle:
            cached = json.load(handle)
        expected = {
            "historyDays": args.history_days,
            "signalDaysPerChunk": args.signal_days,
            "settlementDays": args.settlement_days,
            "universeSize": args.universe_size,
            "dataFrom": getattr(args, "data_from", None),
            "dataTo": getattr(args, "data_to", None),
        }
        if all(cached.get(key) == value for key, value in expected.items()):
            chunks = cached.get("chunks")
            if isinstance(chunks, list) and chunks and all(
                (
                    output / f"chunk-{chunk['index']:02d}" / filename
                ).is_file()
                for chunk in chunks
                for filename in ("daily.json.gz", "funds.json.gz")
            ):
                return cached

    daily = _read_gzip(Path(args.daily).expanduser())
    funds = _read_gzip(Path(args.funds).expanduser())
    dates = sorted({
        str(row.get("date") or "")
        for row in daily
        if (
            str(row.get("date") or "").isdigit()
            and (
                not getattr(args, "data_from", None)
                or str(row.get("date")) >= args.data_from
            )
            and (
                not getattr(args, "data_to", None)
                or str(row.get("date")) <= args.data_to
            )
        )
    })
    chunks = build_chunk_plan(
        dates,
        history_days=args.history_days,
        signal_days=args.signal_days,
        settlement_days=args.settlement_days,
    )
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    for chunk in chunks:
        directory = output / f"chunk-{chunk['index']:02d}"
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        daily_path = directory / "daily.json.gz"
        fund_path = directory / "funds.json.gz"
        if not daily_path.exists():
            _write_gzip(
                daily_path,
                [
                    row for row in daily
                    if chunk["from"] <= str(row.get("date") or "") <= chunk["to"]
                ],
            )
        if not fund_path.exists():
            _write_gzip(
                fund_path,
                [
                    row for row in funds
                    if chunk["from"] <= str(row.get("date") or "") <= chunk["to"]
                ],
            )
    plan = {
        "schemaVersion": "v4-tushare-backfill-plan.v1",
        "historyDays": args.history_days,
        "signalDaysPerChunk": args.signal_days,
        "settlementDays": args.settlement_days,
        "universeSize": args.universe_size,
        "dataFrom": getattr(args, "data_from", None),
        "dataTo": getattr(args, "data_to", None),
        "chunks": chunks,
    }
    plan_path.write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return plan


def _manifest_command(args, chunk, directory):
    return [
        "node",
        "--max-old-space-size=6144",
        str(ROOT / "scripts" / "backfill-opportunity-stockdb.mjs"),
        "--provider",
        "cache",
        "--work-dir",
        str(directory),
        "--from",
        chunk["from"],
        "--to",
        chunk["to"],
        "--signal-days",
        str(chunk["signalDays"]),
        "--universe-size",
        str(args.universe_size),
    ]


def _download_command(args, directory):
    return [
        sys.executable,
        str(ROOT / "scripts" / "tushare_export_history.py"),
        "--stage",
        "minutes",
        "--work-dir",
        str(directory),
        "--manifest",
        str(directory / "minute-manifest.json"),
        "--output-dir",
        str(directory / "minutes"),
        "--max-per-min",
        str(args.max_per_min),
        "--retries",
        str(args.retries),
        "--minute-source",
        str(args.minute_source),
        "--workers",
        str(args.workers),
        "--minimum-coverage",
        str(args.minimum_coverage),
    ]


def _run_resumable_download(args, directory):
    attempt = 0
    while True:
        return_code = _run(
            _download_command(args, directory),
            directory / "minutes.log",
            allow_failure=True,
        )
        if return_code == 0:
            return
        attempt += 1
        if (
            args.download_restarts > 0
            and attempt >= args.download_restarts
        ):
            raise RuntimeError(
                "分钟下载重启次数耗尽，"
                f"查看 {directory / 'minutes.log'}"
            )
        delay = min(
            args.download_retry_max_delay,
            args.download_retry_delay * (2 ** min(attempt - 1, 10)),
        )
        print(json.dumps({
            "stage": "MINUTES_RETRY",
            "chunk": directory.name,
            "attempt": attempt,
            "delaySeconds": delay,
        }), flush=True)
        time.sleep(delay)


def _run_chunk(args, chunk):
    directory = Path(args.output).expanduser().resolve() / (
        f"chunk-{chunk['index']:02d}"
    )
    outcome = directory / "opportunity-outcomes-combined.json"
    v4_outcome = directory / "opportunity-outcomes-v4.json.gz"
    if outcome.is_file() and outcome.stat().st_size > 1024:
        refresh_v4 = bool(getattr(args, "refresh_v4", False))
        cache_matches_alpha = (
            not refresh_v4
            and _v4_cache_matches_alpha(args, directory)
        )
        if not cache_matches_alpha:
            _build_v4_chunk(args, directory)
        if (
            not cache_matches_alpha
            or not (directory / "audit.json").is_file()
        ):
            _write_chunk_audit(directory)
        print(json.dumps({
            "stage": (
                "CHUNK_CACHED"
                if cache_matches_alpha
                else "CHUNK_REBUILT"
            ),
            **chunk,
            "output": str(v4_outcome),
        }), flush=True)
        return

    manifest = directory / "minute-manifest.json"
    if not manifest.is_file():
        # The cache replay intentionally stops on the first missing minute
        # file, after writing the exact causal manifest.
        _run(
            _manifest_command(args, chunk, directory),
            directory / "manifest.log",
            allow_failure=True,
        )
    if not manifest.is_file():
        raise RuntimeError(f"未生成分钟清单: {manifest}")

    minute_report = directory / "tushare-minute-report.json"
    if not minute_report.is_file():
        _run_resumable_download(args, directory)

    _run(
        _manifest_command(args, chunk, directory),
        directory / "replay.log",
    )
    if not outcome.is_file():
        raise RuntimeError(f"回放未生成结果: {outcome}")
    _build_v4_chunk(args, directory)
    _write_chunk_audit(directory)
    print(json.dumps({
        "stage": "CHUNK_DONE",
        **chunk,
        "output": str(v4_outcome),
    }), flush=True)


def _build_v4_chunk(args, directory):
    alpha_snapshot = Path(args.alpha_snapshot).expanduser().resolve()
    if not alpha_snapshot.is_file():
        raise RuntimeError(f"缺少无前视Alpha快照: {alpha_snapshot}")
    _run([
        sys.executable,
        str(ROOT / "scripts" / "build_v4_review_outcomes.py"),
        "--outcomes",
        str(directory / "opportunity-outcomes-combined.json"),
        "--alpha-snapshot",
        str(alpha_snapshot),
        "--output",
        str(directory / "opportunity-outcomes-v4.json.gz"),
        "--report",
        str(directory / "v4-report.json"),
    ], directory / "v4-build.log")


def _training_outcome(outcome):
    context = outcome.get("context") or {}
    review = outcome.get("reviewScoreInput") or {}
    factors = review.get("factors")
    if (
        review.get("schemaVersion") != V4_FEATURE_SCHEMA
        or not isinstance(factors, dict)
        or tuple(factors) != V4_FEATURE_NAMES
    ):
        raise ValueError("最终训练合并发现无效V4特征合同")
    compact_review = {
        key: value
        for key, value in review.items()
        if key != "factors"
    }
    compact_review["factorValues"] = [
        factors[name]
        for name in V4_FEATURE_NAMES
    ]
    return {
        key: outcome[key]
        for key in (
            "decisionId",
            "parentDecisionId",
            "code",
            "tradeDate",
            "maturity",
            "fillStatus",
            "outcome",
            "evaluatedAt",
            "labelSource",
            "exitContractVersion",
            "playbookId",
            "route",
            "entry",
            "exit",
            "metrics",
        )
        if key in outcome
    } | {
        "reviewScoreInput": compact_review,
        "context": {
            key: context[key]
            for key in ("source", "sectorPhase")
            if key in context
        },
    }


def _merge_chunks(args, plan):
    output_root = Path(args.output).expanduser().resolve()
    destination = output_root / "opportunity-outcomes-v4-5y.json.gz"
    temporary = destination.with_suffix(".gz.part")
    seen = set()
    total = 0
    with gzip.open(temporary, "wt", encoding="utf-8") as handle:
        header = {
            "schemaVersion": "opportunity-outcome-export.v1",
            "source": {
                "type": "TUSHARE_CAUSAL_REPLAY",
                "version": "five-year-chunked-v1",
                "chunks": len(plan["chunks"]),
                "featureSchemaVersion": V4_FEATURE_SCHEMA,
                "featureEncoding": "ORDERED_VALUES",
            },
            "range": {
                "from": plan["chunks"][0]["signalFrom"],
                "to": plan["chunks"][-1]["signalTo"],
            },
        }
        prefix = json.dumps(header, ensure_ascii=False, separators=(",", ":"))
        handle.write(prefix[:-1] + ',"outcomes":[')
        first = True
        for chunk in plan["chunks"]:
            source = output_root / (
                f"chunk-{chunk['index']:02d}"
            ) / "opportunity-outcomes-v4.json.gz"
            payload = _read_gzip(source)
            for outcome in payload.get("outcomes") or []:
                decision_id = str(outcome.get("decisionId") or "")
                if not decision_id or decision_id in seen:
                    continue
                seen.add(decision_id)
                if not first:
                    handle.write(",")
                first = False
                json.dump(
                    _training_outcome(outcome),
                    handle,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                total += 1
        handle.write("]}")
    os.chmod(temporary, 0o600)
    os.replace(temporary, destination)
    print(json.dumps({
        "stage": "MERGE_DONE",
        "outcomes": total,
        "output": str(destination),
    }), flush=True)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--daily",
        default=str(Path.home() / ".mainboard-5y" / "mainboard.json.gz"),
    )
    parser.add_argument(
        "--funds",
        default=str(
            Path.home() / ".mainboard-5y" / "mainboard-funds.json.gz"
        ),
    )
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--data-from")
    parser.add_argument("--data-to")
    parser.add_argument("--history-days", type=int, default=60)
    parser.add_argument("--signal-days", type=int, default=145)
    parser.add_argument("--settlement-days", type=int, default=7)
    parser.add_argument("--universe-size", type=int, default=1000)
    parser.add_argument("--max-per-min", type=int, default=60)
    parser.add_argument("--retries", type=int, default=24)
    parser.add_argument(
        "--download-restarts",
        type=int,
        default=0,
        help="分钟下载器失败后的重启次数，0表示不限次数",
    )
    parser.add_argument(
        "--download-retry-delay",
        type=int,
        default=30,
    )
    parser.add_argument(
        "--download-retry-max-delay",
        type=int,
        default=300,
    )
    parser.add_argument(
        "--minute-source",
        choices=("tushare", "mcp", "http"),
        default="http",
    )
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--minimum-coverage", type=float, default=0.85)
    parser.add_argument(
        "--alpha-snapshot",
        default=str(
            Path.home()
            / ".mainboard-5y"
            / "alpha158-snapshot-causal.json.gz"
        ),
    )
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument(
        "--refresh-plan",
        action="store_true",
        help="忽略已有计划并从日线、资金源重新生成分片",
    )
    parser.add_argument(
        "--refresh-v4",
        action="store_true",
        help="复用已完成的行情重放，仅重建V4特征与分片审计",
    )
    parser.add_argument("--from-chunk", type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.max_per_min <= 120:
        parser.error("--max-per-min 必须在1到120之间")
    for field in ("data_from", "data_to"):
        value = getattr(args, field)
        if value is None:
            continue
        normalized = "".join(
            character
            for character in str(value)
            if character.isdigit()
        )
        if len(normalized) != 8:
            parser.error(f"--{field.replace('_', '-')} 必须为YYYYMMDD")
        setattr(args, field, normalized)
    if args.download_restarts < 0:
        parser.error("--download-restarts 不能小于0")
    if args.download_retry_delay < 1:
        parser.error("--download-retry-delay 必须大于0")
    if args.download_retry_max_delay < args.download_retry_delay:
        parser.error(
            "--download-retry-max-delay 不能小于"
            "--download-retry-delay"
        )
    if (
        args.data_from
        and args.data_to
        and args.data_from > args.data_to
    ):
        parser.error("--data-from 不能晚于 --data-to")
    if not args.prepare_only:
        required_env = (
            "STOCK_MCP_URL"
            if args.minute_source in ("mcp", "http")
            else "TUSHARE_TOKEN"
        )
        if not os.environ.get(required_env):
            parser.error(f"执行下载前必须通过环境变量提供{required_env}")
    return args


def main():
    args = parse_args()
    with _exclusive_run_lock(args.output):
        plan = _prepare_chunks(args)
        print(json.dumps({
            "stage": "PLAN_READY",
            "chunks": len(plan["chunks"]),
            "signalDays": sum(row["signalDays"] for row in plan["chunks"]),
            "output": str(Path(args.output).expanduser().resolve()),
        }), flush=True)
        if args.prepare_only:
            return
        for chunk in plan["chunks"]:
            if chunk["index"] < args.from_chunk:
                continue
            _run_chunk(args, chunk)
        _merge_chunks(args, plan)


if __name__ == "__main__":
    main()
