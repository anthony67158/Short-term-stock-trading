"""Run a bounded LightGBM A/B for V2.1 exogenous features."""

import argparse
import json
import os
import time

import numpy as np

from intraday_v21_exogenous_pilot import (
    EXOGENOUS_FEATURE_NAMES,
    build_exogenous_features,
    select_pilot_indices,
)
from train_intraday_tcn import map_barrier_labels
from train_intraday_v21 import (
    SESSION_BUCKETS,
    _metrics,
    three_way_date_split,
    validate_dual_head_dataset,
)
from train_intraday_v21_lgbm import (
    _train_head,
    summarize_indexed_sequences,
)


HEADS = ("next30m", "sessionClose")


def append_exogenous_features(base_features, exogenous):
    """Keep the LightGBM categorical stock code as the final column."""
    base = np.asarray(base_features, dtype=np.float32)
    extra = np.asarray(exogenous, dtype=np.float32)
    if base.ndim != 2 or extra.ndim != 2 or len(base) != len(extra):
        raise ValueError("基础与外生特征必须是等长二维矩阵")
    if base.shape[1] < 1:
        raise ValueError("基础特征缺少股票类别列")
    return np.concatenate(
        (base[:, :-1], extra, base[:, -1:]),
        axis=1,
    ).astype(np.float32)


def pilot_verdict(baseline, augmented):
    improvements = {
        head: (
            float(augmented[head]["balanced_accuracy"])
            - float(baseline[head]["balanced_accuracy"])
        )
        for head in HEADS
    }
    mean = float(np.mean(list(improvements.values())))
    both_improve = all(value >= 0.005 for value in improvements.values())
    decision = "expand_research" if both_improve and mean >= 0.01 else "reject"
    return {
        "decision": decision,
        "head_improvement": improvements,
        "mean_improvement": mean,
        "reason": (
            "双头均改善且平均提升达到1个百分点，可扩大到更多股票和日期复验"
            if decision == "expand_research"
            else "双头没有同时改善至少0.5个百分点，停止扩大试验"
        ),
        "production_eligible": False,
    }


def _fit_variant(
    features,
    labels,
    train_index,
    calibration_index,
    holdout_index,
    *,
    seed,
    num_boost_round,
    early_stopping_rounds,
):
    model = _train_head(
        features[train_index],
        labels[train_index],
        features[calibration_index],
        labels[calibration_index],
        categorical_index=features.shape[1] - 1,
        seed=seed,
        num_boost_round=num_boost_round,
        early_stopping_rounds=early_stopping_rounds,
    )
    probabilities = model.predict(
        features[holdout_index],
        num_iteration=model.best_iteration,
    )
    return {
        "metrics": _metrics(labels[holdout_index], probabilities),
        "probabilities": probabilities,
        "best_iteration": int(model.best_iteration),
    }


def _session_metrics(labels, probabilities, buckets):
    result = {}
    for bucket in sorted(SESSION_BUCKETS):
        selected = np.flatnonzero(buckets == bucket)
        if len(selected):
            result[bucket] = _metrics(
                labels[selected],
                probabilities[selected],
            )
    return result


def run_pilot(
    dataset_path,
    cache_path,
    *,
    max_codes=24,
    max_dates=90,
    seed=42,
    num_boost_round=200,
    early_stopping_rounds=20,
):
    with np.load(dataset_path, allow_pickle=False) as data:
        all_codes = data["codes"].astype(str)
        all_dates = data["dates"].astype(str)
        selected = select_pilot_indices(
            all_codes,
            all_dates,
            max_codes=max_codes,
            max_dates=max_dates,
        )
        values = data["X"][selected].astype(np.float32)
        codes = all_codes[selected]
        dates = all_dates[selected]
        buckets = data["session_bucket"][selected].astype(str)
        raw_next = data["y_next30m"][selected].astype(int)
        raw_close = data["y_session_close"][selected].astype(int)
        source_features = [
            str(value)
            for value in data["feature_names"]
        ]
    validate_dual_head_dataset(values, raw_next, raw_close, buckets)
    if len(np.unique(dates)) < 15:
        raise ValueError("小样本日期不足15个交易日")
    with open(cache_path, encoding="utf-8") as handle:
        cache = json.load(handle)
    exogenous, coverage = build_exogenous_features(codes, dates, cache)
    if max(coverage.values(), default=0.0) <= 0:
        raise ValueError("Tushare外生特征覆盖率为0，不能产生有效A/B结果")

    all_index = np.arange(len(values), dtype=np.int64)
    base_features, categories = summarize_indexed_sequences(
        values,
        all_index,
        codes,
    )
    augmented_features = append_exogenous_features(
        base_features,
        exogenous,
    )
    del values, exogenous
    train_index, calibration_index, holdout_index, split = (
        three_way_date_split(dates)
    )
    labels = {
        "next30m": map_barrier_labels(raw_next),
        "sessionClose": map_barrier_labels(raw_close),
    }
    variants = {
        "baseline": base_features,
        "augmented": augmented_features,
    }
    fitted = {}
    for variant_index, (variant, features) in enumerate(variants.items()):
        fitted[variant] = {}
        for head_index, head in enumerate(HEADS):
            fitted[variant][head] = _fit_variant(
                features,
                labels[head],
                train_index,
                calibration_index,
                holdout_index,
                seed=seed + variant_index * 10 + head_index,
                num_boost_round=num_boost_round,
                early_stopping_rounds=early_stopping_rounds,
            )
    del base_features, augmented_features

    metrics = {
        variant: {
            head: fitted[variant][head]["metrics"]
            for head in HEADS
        }
        for variant in variants
    }
    holdout_buckets = buckets[holdout_index]
    sessions = {
        variant: {
            head: _session_metrics(
                labels[head][holdout_index],
                fitted[variant][head]["probabilities"],
                holdout_buckets,
            )
            for head in HEADS
        }
        for variant in variants
    }
    return {
        "experiment": "v2.1-tushare-exogenous-small-pilot",
        "small_sample_only": True,
        "samples": int(len(codes)),
        "codes": int(len(np.unique(codes))),
        "dates": int(len(np.unique(dates))),
        "split": split,
        "source_feature_names": source_features,
        "exogenous_feature_names": list(EXOGENOUS_FEATURE_NAMES),
        "exogenous_coverage": coverage,
        "stock_categories": categories,
        "best_iteration": {
            variant: {
                head: fitted[variant][head]["best_iteration"]
                for head in HEADS
            }
            for variant in variants
        },
        "metrics": metrics,
        "sessions": sessions,
        "verdict": pilot_verdict(
            metrics["baseline"],
            metrics["augmented"],
        ),
        "trained_at": int(time.time()),
    }


def main():
    parser = argparse.ArgumentParser(
        description="运行V2.1基础与Tushare外生特征小样本A/B",
    )
    parser.add_argument("--data", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-codes", type=int, default=24)
    parser.add_argument("--max-dates", type=int, default=90)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--num-boost-round", type=int, default=200)
    parser.add_argument("--early-stopping-rounds", type=int, default=20)
    args = parser.parse_args()
    result = run_pilot(
        args.data,
        args.cache,
        max_codes=args.max_codes,
        max_dates=args.max_dates,
        seed=args.seed,
        num_boost_round=args.num_boost_round,
        early_stopping_rounds=args.early_stopping_rounds,
    )
    output = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    print(json.dumps({
        "out": output,
        "samples": result["samples"],
        "codes": result["codes"],
        "dates": result["dates"],
        "metrics": result["metrics"],
        "verdict": result["verdict"],
    }, ensure_ascii=False))
    print("INTRADAY_V21_EXOGENOUS_PILOT_OK")


if __name__ == "__main__":
    main()
