"""Train purged-holdout daily barrier and multi-horizon return challengers."""

import argparse
import json
import os
import time

import numpy as np

from time_splits import (
    purged_holdout_split as shared_purged_holdout_split,
    three_way_purged_split,
)

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
    return shared_purged_holdout_split(
        dates,
        holdout_fraction=holdout_fraction,
        purge_dates=purge_dates,
    )


def map_barrier_labels(labels):
    labels = np.asarray(labels, dtype=int)
    if not set(np.unique(labels)).issubset({-1, 0, 1}):
        raise ValueError("barrier labels must contain only -1, 0, and 1")
    return labels + 1


def _balanced_weights(labels, reference_index=None):
    labels = np.asarray(labels, dtype=int)
    reference = labels if reference_index is None else labels[reference_index]
    classes, counts = np.unique(reference, return_counts=True)
    weights = {
        value: len(reference) / (len(classes) * count)
        for value, count in zip(classes, counts)
    }
    return np.asarray(
        [weights.get(value, 1.0) for value in labels],
        dtype=np.float32,
    )


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
    return model, prediction, iterations


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

    train_index, calibration_index, holdout_index, split = (
        three_way_purged_split(
            dates,
            calibration_fraction=0.15,
            holdout_fraction=0.15,
            purge_dates=5,
        )
    )
    final_index = np.sort(np.concatenate([
        train_index,
        calibration_index,
    ]))
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
    train_barrier_weights = _balanced_weights(barrier, train_index)
    calibration_model, _calibration_prob, barrier_iterations = _fit_with_holdout(
        X=X,
        y=barrier,
        train_index=train_index,
        holdout_index=calibration_index,
        params=barrier_params,
        weights=train_barrier_weights,
    )
    barrier_prob = calibration_model.predict(
        X[holdout_index],
        num_iteration=barrier_iterations,
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
    final_barrier_weights = _balanced_weights(barrier, final_index)
    barrier_model = _fit_final(
        X=X[final_index],
        y=barrier[final_index],
        params=barrier_params,
        iterations=barrier_iterations,
        weights=final_barrier_weights[final_index],
    )
    barrier_model.save_model(os.path.join(output_dir, "barrier.txt"))

    regression_params = {
        **COMMON_PARAMS,
        "objective": "huber",
        "metric": "l1",
    }
    metrics["returns"] = {}
    for horizon, target in returns.items():
        calibration_model, _calibration_prediction, iterations = (
            _fit_with_holdout(
                X=X,
                y=target,
                train_index=train_index,
                holdout_index=calibration_index,
                params=regression_params,
            )
        )
        prediction = calibration_model.predict(
            X[holdout_index],
            num_iteration=iterations,
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
            X=X[final_index],
            y=target[final_index],
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
