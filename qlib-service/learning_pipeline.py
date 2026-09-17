"""Daily challenger training from redacted immutable learning views."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pickle
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np


STOCK_FEATURES = (
    "rankingScore",
    "pct",
    "amount",
    "turnover",
    "volumeRatio",
    "mainInflow",
    "mainRatio",
    "recallScore",
    "pFill",
    "pWinGivenFill",
    "expectedNetR",
)
POSITION_FEATURES = (
    "actionCode",
    "referencePrice",
    "entryPrice",
    "stopLoss",
    "takeProfit",
    "pFill",
    "pWinGivenFill",
    "expectedNetR",
)
SEEDS = (17, 41, 97)
BEIJING_TIMEZONE = timezone(timedelta(hours=8))


def _number(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if np.isfinite(number) else 0.0


def _matrix(rows: list[dict], features: tuple[str, ...]) -> np.ndarray:
    return np.asarray(
        [[_number(row.get(name)) for name in features] for row in rows],
        dtype=np.float64,
    )


def expected_settlement_date(now: datetime | None = None) -> str:
    current = (now or datetime.now(timezone.utc)).astimezone(BEIJING_TIMEZONE)
    expected = current.date() - timedelta(days=1)
    while expected.weekday() >= 5:
        expected -= timedelta(days=1)
    return expected.isoformat()


def _canonical_hash(value: dict) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(payload).hexdigest()


def validate_training_view(
    manifest: dict,
    view: dict,
    now: datetime | None = None,
) -> None:
    if manifest.get("schemaVersion") != "learning-manifest.v1":
        raise RuntimeError("unsupported learning manifest")
    manifest_date = str(manifest.get("date") or "")
    expected_date = expected_settlement_date(now)
    if manifest_date < expected_date:
        raise RuntimeError(
            f"stale learning manifest: {manifest_date} < {expected_date}"
        )
    if view.get("schemaVersion") != "learning-training-view.v1":
        raise RuntimeError("unsupported learning training view")
    if str(view.get("date") or "") != manifest_date:
        raise RuntimeError("learning manifest and view dates differ")
    declared_hash = str(view.get("contentHash") or "")
    content = {key: value for key, value in view.items() if key != "contentHash"}
    actual_hash = _canonical_hash(content)
    if not declared_hash or declared_hash != actual_hash:
        raise RuntimeError("learning view content hash mismatch")
    if str(manifest.get("viewHash") or "") != declared_hash:
        raise RuntimeError("learning manifest view hash mismatch")


def _position_rows(rows: list[dict]) -> list[dict]:
    actions = {
        "买入": 1,
        "建仓": 1,
        "加仓": 2,
        "持有": 3,
        "减仓": 4,
        "卖出": 5,
        "清仓": 5,
    }
    return [{
        **row,
        "actionCode": next(
            (
                code for label, code in actions.items()
                if label in str(row.get("action") or "")
            ),
            0,
        ),
    } for row in rows]


def _dates(rows: list[dict]) -> list[str]:
    return sorted({str(row.get("tradeDate") or "") for row in rows if row.get("tradeDate")})


def _split(rows: list[dict], minimum_test_dates: int = 3) -> tuple[list[dict], list[dict]]:
    dates = _dates(rows)
    test_dates = set(dates[-minimum_test_dates:])
    return (
        [row for row in rows if row.get("tradeDate") not in test_dates],
        [row for row in rows if row.get("tradeDate") in test_dates],
    )


def _topk_mean(rows: list[dict], scores: np.ndarray, k: int = 5) -> float:
    grouped: dict[str, list[tuple[float, float]]] = {}
    for row, score in zip(rows, scores, strict=True):
        grouped.setdefault(str(row["tradeDate"]), []).append(
            (float(score), _number(row.get("returnPctT5")))
        )
    daily = []
    for values in grouped.values():
        selected = sorted(values, reverse=True)[:k]
        if selected:
            daily.append(float(np.mean([value[1] for value in selected])))
    return float(np.mean(daily)) if daily else 0.0


def _rank_labels(rows: list[dict]) -> np.ndarray:
    labels = np.zeros(len(rows), dtype=np.int32)
    grouped: dict[str, list[int]] = {}
    for index, row in enumerate(rows):
        grouped.setdefault(str(row["tradeDate"]), []).append(index)
    for indexes in grouped.values():
        ordered = sorted(indexes, key=lambda idx: _number(rows[idx].get("returnPctT5")))
        denominator = max(1, len(ordered) - 1)
        for rank, index in enumerate(ordered):
            labels[index] = min(4, int(rank / denominator * 4))
    return labels


def _group_sizes(rows: list[dict]) -> list[int]:
    groups: dict[str, int] = {}
    for row in rows:
        key = str(row["tradeDate"])
        groups[key] = groups.get(key, 0) + 1
    return [groups[key] for key in sorted(groups)]


@dataclass(frozen=True)
class Gate:
    eligible: bool
    status: str
    reasons: list[str]
    metrics: dict[str, float]


def train_stock_pick(rows: list[dict], output: Path) -> Gate:
    dates = _dates(rows)
    reasons = []
    if len(rows) < 60:
        reasons.append("stock_pick_samples_below_60")
    if len(dates) < 12:
        reasons.append("stock_pick_dates_below_12")
    if reasons:
        return Gate(False, "SKIPPED_INSUFFICIENT_MATURED_DATA", reasons, {
            "samples": float(len(rows)),
            "dates": float(len(dates)),
        })
    train, test = _split(rows)
    if len(_dates(train)) < 6 or len(_dates(test)) < 3:
        return Gate(False, "SKIPPED_INSUFFICIENT_MATURED_DATA", [
            "stock_pick_walk_forward_split_insufficient"
        ], {"samples": float(len(rows)), "dates": float(len(dates))})
    baseline = np.asarray([_number(row.get("rankingScore")) for row in test])
    baseline_top5 = _topk_mean(test, baseline)
    seed_metrics = []
    models = []
    for seed in SEEDS:
        model = lgb.LGBMRanker(
            objective="lambdarank",
            n_estimators=120,
            learning_rate=0.03,
            num_leaves=15,
            min_child_samples=10,
            reg_lambda=1.0,
            random_state=seed,
            verbosity=-1,
        )
        ordered_train = sorted(train, key=lambda row: str(row["tradeDate"]))
        model.fit(
            _matrix(ordered_train, STOCK_FEATURES),
            _rank_labels(ordered_train),
            group=_group_sizes(ordered_train),
        )
        score = model.predict(_matrix(test, STOCK_FEATURES))
        seed_metrics.append(_topk_mean(test, score))
        models.append(model)
    challenger = float(np.mean(seed_metrics))
    minimum_seed = float(np.min(seed_metrics))
    eligible = challenger > baseline_top5 and minimum_seed >= baseline_top5
    if eligible:
        with (output / "stock-pick-challenger.pkl").open("wb") as handle:
            pickle.dump(models, handle)
    return Gate(
        eligible,
        "CHALLENGER_PASSED" if eligible else "CHALLENGER_REJECTED",
        [] if eligible else ["stock_pick_no_fee_adjusted_increment"],
        {
            "samples": float(len(rows)),
            "dates": float(len(dates)),
            "baselineTop5ReturnPct": baseline_top5,
            "challengerTop5ReturnPct": challenger,
            "minimumSeedTop5ReturnPct": minimum_seed,
        },
    )


def train_position(rows: list[dict], output: Path) -> Gate:
    rows = _position_rows(rows)
    dates = _dates(rows)
    reasons = []
    if len(rows) < 30:
        reasons.append("position_samples_below_30")
    if len(dates) < 10:
        reasons.append("position_dates_below_10")
    if reasons:
        return Gate(False, "SKIPPED_INSUFFICIENT_MATURED_DATA", reasons, {
            "samples": float(len(rows)),
            "dates": float(len(dates)),
        })
    train, test = _split(rows)
    baseline = np.asarray([
        _number(row.get("expectedNetR")) for row in test
    ])
    actual = np.asarray([_number(row.get("realizedNetR")) for row in test])
    baseline_mae = float(np.mean(np.abs(baseline - actual)))
    seed_metrics = []
    models = []
    for seed in SEEDS:
        model = lgb.LGBMRegressor(
            objective="huber",
            n_estimators=120,
            learning_rate=0.03,
            num_leaves=15,
            min_child_samples=8,
            reg_lambda=1.0,
            random_state=seed,
            verbosity=-1,
        )
        model.fit(
            _matrix(train, POSITION_FEATURES),
            np.asarray([_number(row.get("realizedNetR")) for row in train]),
        )
        prediction = model.predict(_matrix(test, POSITION_FEATURES))
        seed_metrics.append(float(np.mean(np.abs(prediction - actual))))
        models.append(model)
    challenger_mae = float(np.mean(seed_metrics))
    maximum_seed_mae = float(np.max(seed_metrics))
    eligible = challenger_mae < baseline_mae and maximum_seed_mae <= baseline_mae
    if eligible:
        with (output / "position-challenger.pkl").open("wb") as handle:
            pickle.dump(models, handle)
    return Gate(
        eligible,
        "CHALLENGER_PASSED" if eligible else "CHALLENGER_REJECTED",
        [] if eligible else ["position_no_out_of_sample_mae_increment"],
        {
            "samples": float(len(rows)),
            "dates": float(len(dates)),
            "baselineMaeR": baseline_mae,
            "challengerMaeR": challenger_mae,
            "maximumSeedMaeR": maximum_seed_mae,
        },
    )


def train(view_path: Path, output: Path) -> dict:
    view = json.loads(view_path.read_text(encoding="utf-8"))
    if view.get("schemaVersion") != "learning-training-view.v1":
        raise ValueError("unsupported learning training view")
    output.mkdir(parents=True, exist_ok=True)
    stock = train_stock_pick(list(view.get("stockPick") or []), output)
    position = train_position(list(view.get("position") or []), output)
    generated_at = datetime.now(timezone.utc).isoformat()
    report = {
        "schemaVersion": "learning-training-run.v1",
        "generatedAt": generated_at,
        "sourceView": str(view_path),
        "sourceViewHash": hashlib.sha256(view_path.read_bytes()).hexdigest(),
        "seeds": list(SEEDS),
        "productionPointerChanged": False,
        "stockPick": asdict(stock),
        "position": asdict(position),
        "overallStatus": (
            "CHALLENGERS_READY_FOR_REVIEW"
            if stock.eligible or position.eligible
            else "NO_CHALLENGER_PROMOTION"
        ),
    }
    (output / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return report


def _bucket():
    import oss2

    endpoint = os.environ["OSS_ENDPOINT"]
    bucket_name = os.environ["OSS_BUCKET"]
    auth = oss2.Auth(
        os.environ["OSS_ACCESS_KEY_ID"],
        os.environ["OSS_ACCESS_KEY_SECRET"],
    )
    return oss2.Bucket(auth, endpoint, bucket_name)


def download_latest(
    output: Path,
    now: datetime | None = None,
) -> Path:
    import oss2

    bucket = _bucket()
    prefix = "learning/v1/manifests/"
    manifests = list(oss2.ObjectIterator(bucket, prefix=prefix))
    if not manifests:
        raise RuntimeError("no learning manifest available")
    latest = max(
        manifests,
        key=lambda item: (
            int(getattr(item, "last_modified", 0) or 0),
            str(item.key),
        ),
    )
    manifest = json.loads(bucket.get_object(latest.key).read())
    view_path = str(manifest["viewPath"])
    if not view_path.startswith("learning/v1/views/"):
        raise RuntimeError("manifest points outside redacted learning views")
    view_bytes = bucket.get_object(view_path).read()
    view = json.loads(view_bytes)
    validate_training_view(manifest, view, now)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(view_bytes)
    return output


def upload_run(directory: Path) -> str:
    bucket = _bucket()
    report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
    run_hash = hashlib.sha256(
        json.dumps(report, sort_keys=True).encode()
    ).hexdigest()[:20]
    prefix = f"learning/v1/training-runs/{report['generatedAt'][:10]}/{run_hash}/"
    for path in sorted(directory.iterdir()):
        if path.is_file():
            bucket.put_object(prefix + path.name, path.read_bytes(), headers={
                "x-oss-forbid-overwrite": "true",
            })
    return prefix


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    download_parser = subparsers.add_parser("download")
    download_parser.add_argument("--output", type=Path, required=True)
    train_parser = subparsers.add_parser("train")
    train_parser.add_argument("--view", type=Path, required=True)
    train_parser.add_argument("--output", type=Path, required=True)
    upload_parser = subparsers.add_parser("upload")
    upload_parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "download":
        print(download_latest(args.output))
    elif args.command == "train":
        print(json.dumps(train(args.view, args.output), ensure_ascii=False))
    else:
        print(upload_run(args.directory))


if __name__ == "__main__":
    main()
