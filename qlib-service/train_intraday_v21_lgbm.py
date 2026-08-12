"""Train a tabular LightGBM benchmark on causal V2.1 sequence summaries."""

import argparse
import json
import os
import time

import numpy as np

from train_intraday_tcn import _class_weights, map_barrier_labels
from train_intraday_v21 import (
    SESSION_BUCKETS,
    _metrics,
    apply_probability_calibration,
    select_stable_probability_calibration,
    three_way_date_split,
    validate_dual_head_dataset,
)


MODEL_NAME = "lightgbm-dual-head-sequence-summary"


def sequence_summary_features(values):
    values = np.asarray(values, dtype=np.float32)
    if values.ndim != 3 or not len(values):
        raise ValueError("LightGBM 序列必须是非空三维数组")
    return np.concatenate(
        (
            values[:, -1, :],
            values.mean(axis=1),
            values.std(axis=1),
            values.min(axis=1),
            values.max(axis=1),
            values[:, -1, :] - values[:, 0, :],
        ),
        axis=1,
    ).astype(np.float32)


def summarize_indexed_sequences(
    values,
    indices,
    codes,
    *,
    categories=None,
    chunk_size=25_000,
):
    values = np.asarray(values)
    indices = np.asarray(indices, dtype=np.int64)
    codes = np.asarray(codes).astype(str)
    if values.ndim != 3 or codes.shape != (len(values),):
        raise ValueError("LightGBM 数据字段无效")
    if indices.ndim != 1 or np.any(indices < 0) or np.any(indices >= len(values)):
        raise ValueError("LightGBM 样本索引无效")
    if not isinstance(chunk_size, int) or chunk_size < 1:
        raise ValueError("LightGBM 汇总批次无效")
    categories = (
        sorted(set(codes))
        if categories is None
        else [str(value) for value in categories]
    )
    category_index = {
        code: index
        for index, code in enumerate(categories)
    }
    width = values.shape[2] * 6 + 1
    output = np.empty((len(indices), width), dtype=np.float32)
    for start in range(0, len(indices), chunk_size):
        stop = min(start + chunk_size, len(indices))
        selected = indices[start:stop]
        output[start:stop, :-1] = sequence_summary_features(values[selected])
        output[start:stop, -1] = np.fromiter(
            (category_index.get(code, -1) for code in codes[selected]),
            dtype=np.float32,
            count=len(selected),
        )
    return output, categories


def _sample_training_indices(indices, maximum, seed):
    indices = np.asarray(indices, dtype=np.int64)
    if len(indices) <= maximum:
        return indices
    generator = np.random.default_rng(seed)
    return np.sort(generator.choice(indices, size=maximum, replace=False))


def _train_head(
    train_features,
    train_labels,
    calibration_features,
    calibration_labels,
    *,
    categorical_index,
    seed,
    num_boost_round,
    early_stopping_rounds,
):
    import lightgbm as lgb

    class_weights = _class_weights(train_labels)
    train_set = lgb.Dataset(
        train_features,
        label=train_labels,
        weight=class_weights[train_labels],
        categorical_feature=[categorical_index],
        free_raw_data=False,
    )
    calibration_set = lgb.Dataset(
        calibration_features,
        label=calibration_labels,
        reference=train_set,
        categorical_feature=[categorical_index],
        free_raw_data=False,
    )
    return lgb.train(
        {
            "objective": "multiclass",
            "num_class": 3,
            "metric": "multi_logloss",
            "learning_rate": 0.05,
            "num_leaves": 63,
            "min_data_in_leaf": 500,
            "feature_fraction": 0.85,
            "bagging_fraction": 0.8,
            "bagging_freq": 1,
            "lambda_l1": 0.1,
            "lambda_l2": 1.0,
            "max_bin": 255,
            "num_threads": max(1, os.cpu_count() or 1),
            "seed": seed,
            "feature_fraction_seed": seed,
            "bagging_seed": seed,
            "data_random_seed": seed,
            "deterministic": True,
            "force_col_wise": True,
            "verbosity": -1,
        },
        train_set,
        num_boost_round=num_boost_round,
        valid_sets=[calibration_set],
        valid_names=["calibration"],
        callbacks=[
            lgb.early_stopping(
                early_stopping_rounds,
                first_metric_only=True,
                verbose=True,
            ),
            lgb.log_evaluation(period=20),
        ],
    )


def train_intraday_v21_lgbm(
    dataset_path,
    output_dir,
    *,
    seed=42,
    max_train_samples=3_000_000,
    num_boost_round=500,
    early_stopping_rounds=50,
):
    with np.load(dataset_path, allow_pickle=False) as data:
        values = data["X"].astype(np.float32)
        dates = data["dates"].astype(str)
        as_of = data["as_of"].astype(str)
        codes = data["codes"].astype(str)
        buckets = data["session_bucket"].astype(str)
        raw_next = data["y_next30m"].astype(int)
        raw_close = data["y_session_close"].astype(int)
        feature_names = [str(value) for value in data["feature_names"]]
    shape = validate_dual_head_dataset(
        values,
        raw_next,
        raw_close,
        buckets,
    )
    labels_next = map_barrier_labels(raw_next)
    labels_close = map_barrier_labels(raw_close)
    train_index, calibration_index, holdout_index, split = (
        three_way_date_split(dates)
    )
    sampled_train = _sample_training_indices(
        train_index,
        max_train_samples,
        seed,
    )
    train_features, categories = summarize_indexed_sequences(
        values,
        sampled_train,
        codes,
    )
    calibration_features, _ = summarize_indexed_sequences(
        values,
        calibration_index,
        codes,
        categories=categories,
    )
    holdout_features, _ = summarize_indexed_sequences(
        values,
        holdout_index,
        codes,
        categories=categories,
    )
    del values

    categorical_index = train_features.shape[1] - 1
    next_model = _train_head(
        train_features,
        labels_next[sampled_train],
        calibration_features,
        labels_next[calibration_index],
        categorical_index=categorical_index,
        seed=seed,
        num_boost_round=num_boost_round,
        early_stopping_rounds=early_stopping_rounds,
    )
    close_model = _train_head(
        train_features,
        labels_close[sampled_train],
        calibration_features,
        labels_close[calibration_index],
        categorical_index=categorical_index,
        seed=seed + 1,
        num_boost_round=num_boost_round,
        early_stopping_rounds=early_stopping_rounds,
    )
    calibration_next_prob = next_model.predict(
        calibration_features,
        num_iteration=next_model.best_iteration,
    )
    calibration_close_prob = close_model.predict(
        calibration_features,
        num_iteration=close_model.best_iteration,
    )
    calibration_dates = dates[calibration_index]
    calibration_buckets = buckets[calibration_index]
    calibration = {
        "next30m": select_stable_probability_calibration(
            labels_next[calibration_index],
            calibration_next_prob,
            calibration_buckets,
            calibration_dates,
        ),
        "sessionClose": select_stable_probability_calibration(
            labels_close[calibration_index],
            calibration_close_prob,
            calibration_buckets,
            calibration_dates,
        ),
    }
    raw_next_prob = next_model.predict(
        holdout_features,
        num_iteration=next_model.best_iteration,
    )
    raw_close_prob = close_model.predict(
        holdout_features,
        num_iteration=close_model.best_iteration,
    )
    holdout_buckets = buckets[holdout_index]
    next_prob = apply_probability_calibration(
        raw_next_prob,
        holdout_buckets,
        calibration["next30m"],
    )
    close_prob = apply_probability_calibration(
        raw_close_prob,
        holdout_buckets,
        calibration["sessionClose"],
    )
    metrics = {
        "model": MODEL_NAME,
        "model_version": "v2.1-intraday",
        "seed": seed,
        **shape,
        "split": split,
        "sampled_train_samples": int(len(sampled_train)),
        "summary_features": int(train_features.shape[1]),
        "source_feature_names": feature_names,
        "stock_categories": categories,
        "best_iteration": {
            "next30m": int(next_model.best_iteration),
            "sessionClose": int(close_model.best_iteration),
        },
        "probability_calibration": calibration,
        "raw_heads": {
            "next30m": _metrics(
                labels_next[holdout_index],
                raw_next_prob,
            ),
            "sessionClose": _metrics(
                labels_close[holdout_index],
                raw_close_prob,
            ),
        },
        "heads": {
            "next30m": _metrics(labels_next[holdout_index], next_prob),
            "sessionClose": _metrics(labels_close[holdout_index], close_prob),
        },
        "sessions": {},
        "trained_at": int(time.time()),
    }
    for bucket in sorted(SESSION_BUCKETS):
        selected = np.flatnonzero(holdout_buckets == bucket)
        metrics["sessions"][bucket] = {
            "next30m": _metrics(
                labels_next[holdout_index][selected],
                next_prob[selected],
            ),
            "sessionClose": _metrics(
                labels_close[holdout_index][selected],
                close_prob[selected],
            ),
        }

    os.makedirs(output_dir, exist_ok=True)
    next_model.save_model(os.path.join(output_dir, "v21_next30m_lgbm.txt"))
    close_model.save_model(
        os.path.join(output_dir, "v21_session_close_lgbm.txt")
    )
    with open(
        os.path.join(output_dir, "v21_lgbm_metrics.json"),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(metrics, handle, ensure_ascii=False, indent=2)
    np.savez_compressed(
        os.path.join(output_dir, "v21_lgbm_holdout_predictions.npz"),
        dates=dates[holdout_index],
        as_of=as_of[holdout_index],
        codes=codes[holdout_index],
        session_bucket=holdout_buckets,
        actual_next30m=labels_next[holdout_index],
        next30m_prob=next_prob.astype(np.float32),
        actual_session_close=labels_close[holdout_index],
        session_close_prob=close_prob.astype(np.float32),
    )
    return metrics


def main():
    parser = argparse.ArgumentParser(
        description="训练 V2.1 LightGBM 双头序列汇总基准",
    )
    parser.add_argument("--data", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--max-train-samples", type=int, default=3_000_000)
    parser.add_argument("--num-boost-round", type=int, default=500)
    parser.add_argument("--early-stopping-rounds", type=int, default=50)
    args = parser.parse_args()
    metrics = train_intraday_v21_lgbm(
        args.data,
        args.out_dir,
        seed=args.seed,
        max_train_samples=args.max_train_samples,
        num_boost_round=args.num_boost_round,
        early_stopping_rounds=args.early_stopping_rounds,
    )
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    print("INTRADAY_V21_LGBM_TRAINING_OK")


if __name__ == "__main__":
    main()
