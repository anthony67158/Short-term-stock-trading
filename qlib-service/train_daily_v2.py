"""Train purged-holdout daily barrier and multi-horizon return challengers."""

import argparse
import json
import math
import os
import time

import numpy as np


COMMON_PARAMS = {
    "boosting_type": "gbdt",
    "num_leaves": 63,
    "max_depth": 7,
    "learning_rate": 0.03,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "min_data_in_leaf": 150,
    "lambda_l1": 1.0,
    "lambda_l2": 2.0,
    "verbosity": -1,
    "seed": 42,
    "feature_pre_filter": False,
}


def purged_holdout_split(dates, *, holdout_fraction=0.15, purge_dates=5):
    dates = np.asarray(dates).astype(str)
    if dates.ndim != 1 or not len(dates):
        raise ValueError("dates must be a non-empty one-dimensional array")
    if not 0 < holdout_fraction < 0.5:
        raise ValueError("holdout_fraction must be between zero and 0.5")
    if not isinstance(purge_dates, int) or purge_dates < 0:
        raise ValueError("purge_dates must be a non-negative integer")

    unique_dates = np.unique(dates)
    holdout_count = max(1, math.ceil(len(unique_dates) * holdout_fraction))
    holdout_position = len(unique_dates) - holdout_count
    purge_position = holdout_position - purge_dates
    if purge_position <= 0:
        raise ValueError("dataset is too short for the requested purge")

    holdout_start = unique_dates[holdout_position]
    purge_start = unique_dates[purge_position]
    train_index = np.flatnonzero(dates < purge_start)
    holdout_index = np.flatnonzero(dates >= holdout_start)
    if not len(train_index) or not len(holdout_index):
        raise ValueError("purged split produced an empty partition")
    return train_index, holdout_index, {
        "holdout_start_date": str(holdout_start),
        "purge_start_date": str(purge_start),
        "purge_dates": purge_dates,
        "train_samples": int(len(train_index)),
        "holdout_samples": int(len(holdout_index)),
    }


def map_barrier_labels(labels):
    labels = np.asarray(labels, dtype=int)
    if not set(np.unique(labels)).issubset({-1, 0, 1}):
        raise ValueError("barrier labels must contain only -1, 0, and 1")
    return labels + 1


def _balanced_weights(labels):
    labels = np.asarray(labels, dtype=int)
    classes, counts = np.unique(labels, return_counts=True)
    weights = {
        value: len(labels) / (len(classes) * count)
        for value, count in zip(classes, counts)
    }
    return np.asarray([weights[value] for value in labels], dtype=np.float32)


def _fit_with_holdout(
    *,
    X,
    y,
    train_index,
    holdout_index,
    params,
    weights=None,
):
    import lightgbm as lgb

    train_weights = weights[train_index] if weights is not None else None
    train_data = lgb.Dataset(
        X[train_index],
        y[train_index],
        weight=train_weights,
    )
    holdout_data = lgb.Dataset(
        X[holdout_index],
        y[holdout_index],
        reference=train_data,
    )
    model = lgb.train(
        params,
        train_data,
        num_boost_round=2000,
        valid_sets=[holdout_data],
        callbacks=[
            lgb.early_stopping(100, verbose=False),
            lgb.log_evaluation(0),
        ],
    )
    iterations = model.best_iteration or 300
    prediction = model.predict(
        X[holdout_index],
        num_iteration=iterations,
    )
    return prediction, iterations


def _fit_final(*, X, y, params, iterations, weights=None):
    import lightgbm as lgb

    dataset = lgb.Dataset(X, y, weight=weights)
    return lgb.train(params, dataset, num_boost_round=iterations)


def train_models(dataset_path, output_dir):
    from scipy.stats import spearmanr
    from sklearn.metrics import (
        balanced_accuracy_score,
        f1_score,
        log_loss,
        mean_absolute_error,
    )

    with np.load(dataset_path, allow_pickle=True) as data:
        X = data["X"].astype(np.float32)
        dates = data["dates"].astype(str)
        codes = data["codes"].astype(str)
        features = [str(value) for value in data["feat_names"]]
        barrier = map_barrier_labels(data["y_barrier"])
        returns = {
            horizon: data[f"y_return_{horizon}d"].astype(np.float32)
            for horizon in (1, 3, 5)
        }

    train_index, holdout_index, split = purged_holdout_split(
        dates,
        holdout_fraction=0.15,
        purge_dates=5,
    )
    os.makedirs(output_dir, exist_ok=True)
    metrics = {
        "samples": int(len(X)),
        "features": int(X.shape[1]),
        "feature_names": features,
        "split": split,
        "trained_at": int(time.time()),
    }

    barrier_params = {
        **COMMON_PARAMS,
        "objective": "multiclass",
        "metric": "multi_logloss",
        "num_class": 3,
    }
    barrier_weights = _balanced_weights(barrier)
    barrier_prob, barrier_iterations = _fit_with_holdout(
        X=X,
        y=barrier,
        train_index=train_index,
        holdout_index=holdout_index,
        params=barrier_params,
        weights=barrier_weights,
    )
    barrier_prediction = np.argmax(barrier_prob, axis=1)
    prediction_snapshot = {
        "dates": dates[holdout_index],
        "codes": codes[holdout_index],
        "actual_barrier": barrier[holdout_index],
        "predicted_barrier": barrier_prediction,
        "barrier_prob": barrier_prob.astype(np.float32),
    }
    metrics["barrier"] = {
        "iterations": int(barrier_iterations),
        "macro_f1": float(
            f1_score(
                barrier[holdout_index],
                barrier_prediction,
                average="macro",
            )
        ),
        "balanced_accuracy": float(
            balanced_accuracy_score(
                barrier[holdout_index],
                barrier_prediction,
            )
        ),
        "log_loss": float(
            log_loss(
                barrier[holdout_index],
                barrier_prob,
                labels=[0, 1, 2],
            )
        ),
    }
    barrier_model = _fit_final(
        X=X,
        y=barrier,
        params=barrier_params,
        iterations=barrier_iterations,
        weights=barrier_weights,
    )
    barrier_model.save_model(os.path.join(output_dir, "barrier.txt"))

    regression_params = {
        **COMMON_PARAMS,
        "objective": "huber",
        "metric": "l1",
    }
    metrics["returns"] = {}
    for horizon, target in returns.items():
        prediction, iterations = _fit_with_holdout(
            X=X,
            y=target,
            train_index=train_index,
            holdout_index=holdout_index,
            params=regression_params,
        )
        correlation = spearmanr(
            target[holdout_index],
            prediction,
        ).statistic
        metrics["returns"][f"{horizon}d"] = {
            "iterations": int(iterations),
            "mae": float(
                mean_absolute_error(target[holdout_index], prediction)
            ),
            "spearman": (
                float(correlation) if np.isfinite(correlation) else 0.0
            ),
        }
        prediction_snapshot[f"actual_return_{horizon}d"] = target[
            holdout_index
        ]
        prediction_snapshot[f"predicted_return_{horizon}d"] = np.asarray(
            prediction,
            dtype=np.float32,
        )
        model = _fit_final(
            X=X,
            y=target,
            params=regression_params,
            iterations=iterations,
        )
        model.save_model(
            os.path.join(output_dir, f"return_{horizon}d.txt")
        )

    np.savez_compressed(
        os.path.join(output_dir, "holdout_predictions.npz"),
        **prediction_snapshot,
    )
    metadata_path = os.path.join(output_dir, "daily_v2_metrics.json")
    with open(metadata_path, "w", encoding="utf-8") as handle:
        json.dump(metrics, handle, ensure_ascii=False, indent=2)
    return metrics


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="full477/dataset_v2.npz")
    parser.add_argument("--out-dir", default="full477/daily_v2")
    args = parser.parse_args()

    metrics = train_models(args.data, args.out_dir)
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    print("DAILY_V2_TRAINING_OK")


if __name__ == "__main__":
    main()
