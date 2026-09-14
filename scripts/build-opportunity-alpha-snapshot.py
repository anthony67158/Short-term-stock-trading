#!/usr/bin/env python3
"""Build causal Alpha158 scores trained on the best realized review path."""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "qlib-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from decision_engine.training.evaluation import (  # noqa: E402
    block_bootstrap_lower_bound,
    ranking_metrics,
)
from decision_engine.training.opportunity_alpha import (  # noqa: E402
    aggregate_stock_day_targets,
    date_start_ms,
    momentum_by_code,
    percentile_by_date,
    rolling_mature_rank_ic,
)
from decision_engine.training.review_dataset import (  # noqa: E402
    load_opportunity_review_dataset,
)


SNAPSHOT_SCHEMA_VERSION = "alpha158-opportunity-snapshot.v1"
SIGNAL_FEATURE_SCHEMA = "opportunity-alpha158-signal.v1"


def _aligned_target_rows(panel, targets):
    panel_dates = np.asarray(panel["dates"]).astype(str)
    panel_codes = np.asarray(panel["codes"]).astype(str)
    panel_keys = np.char.add(np.char.add(panel_dates, ":"), panel_codes)
    target_keys = np.char.add(
        np.char.add(targets["dates"].astype(str), ":"),
        targets["codes"].astype(str),
    )
    order = np.argsort(panel_keys, kind="stable")
    sorted_keys = panel_keys[order]
    positions = np.searchsorted(sorted_keys, target_keys)
    matched = positions < len(sorted_keys)
    matched[matched] &= (
        sorted_keys[positions[matched]] == target_keys[matched]
    )
    return np.flatnonzero(matched), order[positions[matched]]


def _fit_regressor(matrix, labels, *, estimators, threads):
    import lightgbm as lgb

    model = lgb.LGBMRegressor(
        objective="regression",
        n_estimators=estimators,
        learning_rate=0.03,
        num_leaves=15,
        max_depth=5,
        min_child_samples=100,
        subsample=0.85,
        subsample_freq=1,
        colsample_bytree=0.7,
        reg_alpha=1.0,
        reg_lambda=10.0,
        random_state=42,
        n_jobs=threads,
        verbosity=-1,
    )
    model.fit(matrix, np.clip(labels, -3.0, 3.0))
    return model


def _snapshot_rows(
    panel,
    targets,
    scores,
    block_ids,
):
    panel_dates = np.asarray(panel["dates"]).astype(str)
    panel_codes = np.asarray(panel["codes"]).astype(str)
    scored = np.flatnonzero(np.isfinite(scores))
    scored_dates = panel_dates[scored]
    scored_codes = panel_codes[scored]
    scored_values = scores[scored]
    percentiles = percentile_by_date(scored_values, scored_dates)
    momentum = momentum_by_code(
        percentiles,
        scored_codes,
        scored_dates,
        lag=5,
    )

    target_rows, panel_rows = _aligned_target_rows(panel, targets)
    available = np.isfinite(scores[panel_rows])
    target_rows = target_rows[available]
    panel_rows = panel_rows[available]
    target_scores = scores[panel_rows]
    rank_ic20 = rolling_mature_rank_ic(
        target_scores,
        targets["y_best_net_r"][target_rows],
        targets["dates"][target_rows],
        targets["label_end_ms"][target_rows],
        np.unique(scored_dates),
        window=20,
    )
    rank_ic60 = rolling_mature_rank_ic(
        target_scores,
        targets["y_best_net_r"][target_rows],
        targets["dates"][target_rows],
        targets["label_end_ms"][target_rows],
        np.unique(scored_dates),
        window=60,
    )

    scored_lookup = {
        int(panel_index): position
        for position, panel_index in enumerate(scored)
    }
    rows = []
    for panel_index in panel_rows:
        position = scored_lookup[int(panel_index)]
        percentile = float(percentiles[position])
        date = str(panel_dates[panel_index])
        rows.append({
            "date": date,
            "code": str(panel_codes[panel_index]),
            "rawScore": round(float(scores[panel_index]), 8),
            "percentile": round(percentile, 6),
            "centeredZ": round(
                float(np.clip((percentile - 0.5) * 2, -1, 1)),
                6,
            ),
            "rankIc20": round(
                float(np.clip(rank_ic20[date], -1, 1)),
                6,
            ),
            "rankIc60": round(
                float(np.clip(rank_ic60[date], -1, 1)),
                6,
            ),
            "scoreMomentum5": round(float(momentum[position]), 6),
            "fold": int(block_ids[panel_index]),
        })
    rows.sort(key=lambda row: (row["date"], row["code"]))
    return rows, target_rows, panel_rows


def build_snapshot(
    panel,
    dataset,
    *,
    warmup_days=120,
    block_days=60,
    estimators=300,
    threads=4,
    minimum_training_samples=5_000,
):
    panel_dates = np.asarray(panel["dates"]).astype(str)
    panel_matrix = np.asarray(panel["X"], dtype=np.float32)
    market_dates = sorted(set(panel_dates.tolist()))
    targets = aggregate_stock_day_targets(dataset, market_dates)
    target_rows, panel_rows = _aligned_target_rows(panel, targets)
    target_dates = targets["dates"][target_rows]
    available_dates = sorted(set(target_dates.tolist()))
    if len(available_dates) <= warmup_days:
        raise ValueError("Alpha机会目标交易日不足")

    scores = np.full(len(panel_dates), np.nan, dtype=np.float64)
    block_ids = np.zeros(len(panel_dates), dtype=np.int16)
    blocks = []
    for offset in range(warmup_days, len(available_dates), block_days):
        score_dates = available_dates[offset:offset + block_days]
        start_date = score_dates[0]
        start_ms = date_start_ms(start_date)
        training_mask = (
            (targets["dates"][target_rows] < start_date)
            & (targets["label_end_ms"][target_rows] < start_ms)
        )
        train_target_rows = target_rows[training_mask]
        if len(train_target_rows) < minimum_training_samples:
            continue
        train_panel_rows = panel_rows[training_mask]
        model = _fit_regressor(
            panel_matrix[train_panel_rows],
            targets["y_best_net_r"][train_target_rows],
            estimators=estimators,
            threads=threads,
        )
        score_rows = np.flatnonzero(np.isin(panel_dates, score_dates))
        scores[score_rows] = model.predict(panel_matrix[score_rows])
        block_id = len(blocks) + 1
        block_ids[score_rows] = block_id
        blocks.append({
            "block": block_id,
            "trainEndDate": str(
                max(targets["dates"][train_target_rows])
            ),
            "scoreStartDate": score_dates[0],
            "scoreEndDate": score_dates[-1],
            "trainSamples": int(len(train_target_rows)),
            "scoreSamples": int(len(score_rows)),
        })
        print(json.dumps({
            "stage": "OPPORTUNITY_ALPHA_BLOCK",
            **blocks[-1],
        }), flush=True)

    rows, scored_targets, scored_panel = _snapshot_rows(
        panel,
        targets,
        scores,
        block_ids,
    )
    score_values = scores[scored_panel]
    base = ranking_metrics(
        targets["y_best_net_r"][scored_targets] > 0,
        targets["y_best_net_r"][scored_targets],
        score_values,
        targets["dates"][scored_targets],
        top_k=5,
        group_ids=targets["codes"][scored_targets],
    )
    stress = ranking_metrics(
        targets["y_best_net_r_stress10"][scored_targets] > 0,
        targets["y_best_net_r_stress10"][scored_targets],
        score_values,
        targets["dates"][scored_targets],
        top_k=5,
        group_ids=targets["codes"][scored_targets],
    )
    report = {
        "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
        "generatedAt": int(time.time() * 1000),
        "signalFeatureSchema": SIGNAL_FEATURE_SCHEMA,
        "target": "BEST_REVIEW_ACTION_NET_R_WITH_NO_TRADE_FLOOR",
        "causalPolicy": "LABEL_END_BEFORE_SCORE_DAY",
        "warmupDays": warmup_days,
        "blockDays": block_days,
        "blocks": blocks,
        "rows": len(rows),
        "targetRows": len(targets["dates"]),
        "matchedTargetRows": int(len(target_rows)),
        "scoredTargetRows": int(len(scored_targets)),
        "coverage": round(
            len(scored_targets) / len(target_rows),
            6,
        ),
        "top5": {
            "meanNetR": base["mean_net_r_at_5"],
            "lowerBound95": block_bootstrap_lower_bound(
                base["daily_net_r"],
                samples=5_000,
                random_state=42,
            ),
            "stress10MeanNetR": stress["mean_net_r_at_5"],
            "stress10LowerBound95": block_bootstrap_lower_bound(
                stress["daily_net_r"],
                samples=5_000,
                random_state=42,
            ),
        },
    }
    return {
        "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
        "signalFeatureSchema": SIGNAL_FEATURE_SCHEMA,
        "generatedAt": report["generatedAt"],
        "target": report["target"],
        "rows": rows,
        "blocks": blocks,
    }, report


def _write_json(path, payload):
    destination = Path(path).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    opener = gzip.open if str(destination).endswith(".gz") else open
    with opener(destination, "wt", encoding="utf-8") as handle:
        json.dump(
            payload,
            handle,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )


def main():
    from decision_engine.training.alpha158_mainboard import load_panel

    parser = argparse.ArgumentParser()
    parser.add_argument("--panel", required=True)
    parser.add_argument("--review-dataset", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--warmup-days", type=int, default=120)
    parser.add_argument("--block-days", type=int, default=60)
    parser.add_argument("--estimators", type=int, default=300)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--minimum-training-samples", type=int, default=5_000)
    args = parser.parse_args()
    snapshot, report = build_snapshot(
        load_panel(args.panel),
        load_opportunity_review_dataset(args.review_dataset),
        warmup_days=args.warmup_days,
        block_days=args.block_days,
        estimators=args.estimators,
        threads=args.threads,
        minimum_training_samples=args.minimum_training_samples,
    )
    _write_json(args.output, snapshot)
    _write_json(args.report, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
