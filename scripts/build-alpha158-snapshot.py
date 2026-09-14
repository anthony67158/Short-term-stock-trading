#!/usr/bin/env python3
"""生成 Alpha158 主板「每股每日」连续信号快照（R2 依赖项）。

与 walkforward 只落地 Top100 不同，本脚本对每折验证期的**全体候选**打分，并按
决策日横截面计算：
  - percentile      分位（0..1）
  - centeredZ       分位居中到 [-1,1]
  - rankIc20/60     该股所属折的近端/整体 RankIC（作为可靠性上下文，全折同值）
  - scoreMomentum5  个股分数的 5 日动量（当日分位 - 5 交易日前分位）
输出每股每日快照，字段与 shared/alpha158SignalFeatures.js 的输入口径对齐，
供 R2 装配 opportunity-review-feature.v4 的 8 维 alpha 特征块。

复用 alpha158_mainboard 的 build_panel/_folds/_fit_model，不改其既有函数。
纯计算函数(_percentile_by_date/_momentum_by_code)可离线单测。
"""

import argparse
import gzip
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "qlib-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from decision_engine.training.alpha158_mainboard import (  # noqa: E402
    _fit_model,
    _folds,
    _spearman,
    build_panel,
    load_panel,
    save_panel,
)


def _percentile_by_date(scores, dates):
    """按日横截面把分数映射为分位(0..1，同日内 rank/(n-1))。纯函数。"""
    out = np.zeros(len(scores), dtype=np.float64)
    for date in np.unique(dates):
        idx = np.flatnonzero(dates == date)
        if len(idx) == 1:
            out[idx[0]] = 0.5
            continue
        order = np.argsort(scores[idx], kind="stable")
        ranks = np.empty(len(idx), dtype=np.float64)
        ranks[order] = np.arange(len(idx), dtype=np.float64)
        out[idx] = ranks / (len(idx) - 1)
    return out


def _momentum_by_code(percentiles, codes, dates, *, lag=5):
    """个股分位的 lag 日动量：当日分位 - lag 个交易日前分位。纯函数。

    以每只股票自身的时间序列计算，缺前值时为 0。
    """
    out = np.zeros(len(percentiles), dtype=np.float64)
    by_code = defaultdict(list)
    for i in range(len(percentiles)):
        by_code[str(codes[i])].append(i)
    for _code, indices in by_code.items():
        ordered = sorted(indices, key=lambda i: str(dates[i]))
        for pos, i in enumerate(ordered):
            if pos >= lag:
                out[i] = percentiles[i] - percentiles[ordered[pos - lag]]
    return out


def _rolling_rank_ic(scores, labels, dates, *, window):
    """每个交易日的滚动 RankIC：此前 window 个交易日的日度 RankIC 均值。

    先算每个交易日截面的日度 RankIC(预测 vs 真实标签)，再对交易日序列做
    严格滞后一日的尾部 window 均值，映射回每个样本所在日。当天标签在决策时
    尚未成熟，绝不能进入当天特征；早期不足 window 时用此前已有日均值，
    无历史时为 0。
    """
    unique_dates = sorted(set(dates.tolist()))
    daily_ic = {}
    for d in unique_dates:
        idx = np.flatnonzero(dates == d)
        if len(idx) < 5:
            daily_ic[d] = np.nan
            continue
        left, right = scores[idx], labels[idx]
        if left.std() > 1e-12 and right.std() > 1e-12:
            daily_ic[d] = _spearman(left, right)
        else:
            daily_ic[d] = np.nan
    # 滚动均值（按交易日序）。
    rolled = {}
    seq = [daily_ic[d] for d in unique_dates]
    for pos, d in enumerate(unique_dates):
        lo = max(0, pos - window)
        vals = [v for v in seq[lo:pos] if v == v]  # 严格排除当天
        rolled[d] = float(np.mean(vals)) if vals else 0.0
    return np.array([rolled[d] for d in dates], dtype=np.float64)


def build_snapshot(panel, *, threads=4):
    fold_reports = []
    rows = []
    for index, fold in enumerate(_folds(panel), start=1):
        model = _fit_model(panel, fold, threads)
        validation = fold["validation"]
        scores = np.asarray(
            model.predict(
                panel["X"][validation],
                num_iteration=model.best_iteration,
            ),
            dtype=np.float64,
        )
        v_dates = panel["dates"][validation].astype(str)
        v_codes = panel["codes"][validation].astype(str)
        v_labels = np.asarray(panel["y_raw"][validation], dtype=np.float64)
        pct = _percentile_by_date(scores, v_dates)
        centered = np.clip((pct - 0.5) * 2, -1, 1)
        momentum = _momentum_by_code(pct, v_codes, v_dates, lag=5)
        ic20 = _rolling_rank_ic(scores, v_labels, v_dates, window=20)
        ic60 = _rolling_rank_ic(scores, v_labels, v_dates, window=60)
        meta = fold["metadata"]
        for i in range(len(validation)):
            rows.append({
                "date": v_dates[i],
                "code": v_codes[i],
                "percentile": round(float(pct[i]), 6),
                "centeredZ": round(float(centered[i]), 6),
                "rankIc20": round(float(np.clip(ic20[i], -1, 1)), 6),
                "rankIc60": round(float(np.clip(ic60[i], -1, 1)), 6),
                "scoreMomentum5": round(float(momentum[i]), 6),
                "fold": index,
            })
        fold_reports.append({"fold": index, **meta})
    rows.sort(key=lambda r: (r["date"], r["code"]))
    return {
        "schemaVersion": "alpha158-mainboard-snapshot.v1",
        "signalFeatureSchema": "opportunity-alpha158-signal.v1",
        "days": len(sorted({r["date"] for r in rows})),
        "rows": rows,
        "folds": fold_reports,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--daily", required=True)
    parser.add_argument("--panel", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--from", dest="start_date")
    parser.add_argument("--to", dest="end_date")
    parser.add_argument("--universe-size", type=int, default=1000)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()

    if args.rebuild or not os.path.isfile(args.panel):
        panel = build_panel(
            args.daily,
            start_date=args.start_date,
            end_date=args.end_date,
            universe_size=args.universe_size,
        )
        save_panel(args.panel, panel)
    else:
        panel = load_panel(args.panel)
    snapshot = build_snapshot(panel, threads=args.threads)
    payload = json.dumps(
        snapshot, ensure_ascii=False, allow_nan=False, separators=(",", ":"),
    ).encode("utf-8")
    with gzip.open(args.output, "wb") as handle:
        handle.write(payload)
    print(json.dumps({
        "output": os.path.abspath(args.output),
        "days": snapshot["days"],
        "rows": len(snapshot["rows"]),
        "folds": snapshot["folds"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
