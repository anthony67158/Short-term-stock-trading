"""Train a CPU-only 36-factor ranker for cross-sectional 5-day returns."""

import argparse
import json
import os
import time

import numpy as np

from train_36_max import (
    date_grouped_indices,
    return_relevance_labels,
    three_way_purged_split,
)


SPECS = [
    {
        "name": "compact_linear",
        "params": {
            "num_leaves": 31,
            "max_depth": 6,
            "min_data_in_leaf": 300,
            "feature_fraction": 0.85,
            "lambda_l2": 5.0,
            "label_gain": [0, 1, 2, 3, 4],
        },
    },
    {
        "name": "compact_exponential",
        "params": {
            "num_leaves": 31,
            "max_depth": 6,
            "min_data_in_leaf": 300,
            "feature_fraction": 0.85,
            "lambda_l2": 5.0,
            "label_gain": [0, 1, 3, 7, 15],
        },
    },
    {
        "name": "balanced_63",
        "params": {
            "num_leaves": 63,
            "max_depth": 8,
            "min_data_in_leaf": 400,
            "feature_fraction": 0.9,
            "lambda_l1": 1.0,
            "lambda_l2": 8.0,
            "label_gain": [0, 1, 2, 4, 8],
        },
    },
    {
        "name": "wide_regularized",
        "params": {
            "num_leaves": 127,
            "max_depth": 9,
            "min_data_in_leaf": 600,
            "feature_fraction": 0.9,
            "lambda_l1": 3.0,
            "lambda_l2": 10.0,
            "label_gain": [0, 1, 2, 4, 8],
        },
    },
    {
        "name": "coarse_bins",
        "params": {
            "num_leaves": 63,
            "max_depth": 8,
            "min_data_in_leaf": 400,
            "feature_fraction": 0.9,
            "lambda_l2": 8.0,
            "max_bin": 63,
            "label_gain": [0, 1, 2, 4, 8],
        },
    },
    {
        "name": "fine_bins",
        "params": {
            "num_leaves": 63,
            "max_depth": 8,
            "min_data_in_leaf": 400,
            "feature_fraction": 0.9,
            "lambda_l2": 8.0,
            "max_bin": 511,
            "label_gain": [0, 1, 2, 4, 8],
        },
    },
]


def top_k_return_metrics(dates, returns, scores, *, top_k=3):
    dates = np.asarray(dates).astype(str)
    returns = np.asarray(returns, dtype=float)
    scores = np.asarray(scores, dtype=float)
    if not (dates.shape == returns.shape == scores.shape):
        raise ValueError("dates, returns, and scores must have equal shapes")
    selected = []
    daily = []
    for date in np.unique(dates):
        indices = np.flatnonzero(dates == date)
        ranked = indices[np.argsort(-scores[indices], kind="stable")[:top_k]]
        selected.extend(ranked)
        daily.append(float(returns[ranked].mean()))
    selected = np.asarray(selected, dtype=np.int64)
    daily = np.asarray(daily, dtype=float)
    standard_error = float(daily.std(ddof=1) / np.sqrt(len(daily)))
    return {
        "signals": int(len(selected)),
        "dates": int(len(daily)),
        "win_rate": float(np.mean(returns[selected] > 0)),
        "mean_return": float(np.mean(returns[selected])),
        "median_return": float(np.median(returns[selected])),
        "mean_daily_return": float(daily.mean()),
        "daily_standard_error": standard_error,
        "selection_score": float(daily.mean() - 0.5 * standard_error),
    }


def _params(spec, seed, threads):
    return {
        "objective": "lambdarank",
        "metric": "ndcg",
        "ndcg_eval_at": [3],
        "boosting_type": "gbdt",
        "learning_rate": 0.02,
        "bagging_fraction": 0.85,
        "bagging_freq": 1,
        "feature_pre_filter": False,
        "verbosity": -1,
        "deterministic": True,
        "force_col_wise": True,
        "num_threads": threads,
        "seed": seed,
        "feature_fraction_seed": seed,
        "bagging_seed": seed,
        "data_random_seed": seed,
        **spec["params"],
    }


def _fit_search(X, labels, dates, train_index, valid_index, spec, seed, threads):
    import lightgbm as lgb

    train_order, train_groups = date_grouped_indices(dates, train_index)
    valid_order, valid_groups = date_grouped_indices(dates, valid_index)
    train = lgb.Dataset(
        X[train_order],
        labels[train_order],
        group=train_groups,
    )
    valid = lgb.Dataset(
        X[valid_order],
        labels[valid_order],
        group=valid_groups,
        reference=train,
    )
    model = lgb.train(
        _params(spec, seed, threads),
        train,
        num_boost_round=2500,
        valid_sets=[valid],
        callbacks=[
            lgb.early_stopping(150, verbose=False),
            lgb.log_evaluation(0),
        ],
    )
    return model, int(model.best_iteration or 300)


def _fit_final(X, labels, dates, indices, spec, result, threads):
    import lightgbm as lgb

    ordered, groups = date_grouped_indices(dates, indices)
    dataset = lgb.Dataset(X[ordered], labels[ordered], group=groups)
    return lgb.train(
        _params(spec, result["seed"], threads),
        dataset,
        num_boost_round=result["iterations"],
    )


def train_return_ranker(
    base_path,
    return_path,
    output_dir,
    *,
    seeds,
    threads,
):
    with np.load(base_path, allow_pickle=True) as data:
        X = data["X"].astype(np.float32)
        dates = data["dates"].astype(str)
        codes = data["codes"].astype(str)
        feature_names = [str(value) for value in data["feat_names"]]
    with np.load(return_path, allow_pickle=True) as data:
        return_dates = data["dates"].astype(str)
        return_codes = data["codes"].astype(str)
        returns = data["y_return_5d"].astype(np.float32)
    if X.shape[1] != 36 or len(feature_names) != 36:
        raise ValueError("return ranker requires the exact 36-factor dataset")
    if not (
        np.array_equal(dates, return_dates)
        and np.array_equal(codes, return_codes)
    ):
        raise ValueError("base and return datasets are not row-aligned")

    labels = return_relevance_labels(dates, returns, levels=5)
    train_index, calibration_index, holdout_index, split = (
        three_way_purged_split(dates)
    )
    results = []
    started = time.time()
    for spec in SPECS:
        for seed in seeds:
            model, iterations = _fit_search(
                X,
                labels,
                dates,
                train_index,
                calibration_index,
                spec,
                seed,
                threads,
            )
            prediction = model.predict(
                X[calibration_index],
                num_iteration=iterations,
            )
            metrics = top_k_return_metrics(
                dates[calibration_index],
                returns[calibration_index],
                prediction,
            )
            result = {
                "name": spec["name"],
                "seed": seed,
                "iterations": iterations,
                "params": spec["params"],
                "calibration": metrics,
            }
            results.append(result)
            print(
                f"[return-calibration] {spec['name']} seed={seed} "
                f"mean={metrics['mean_return']:.5f} "
                f"win={metrics['win_rate']:.4f} iter={iterations}",
                flush=True,
            )

    selected = sorted(
        results,
        key=lambda item: item["calibration"]["selection_score"],
        reverse=True,
    )[:3]
    spec_by_name = {spec["name"]: spec for spec in SPECS}
    fit_index = np.flatnonzero(dates < split["holdout_purge_dates"][0])
    os.makedirs(output_dir, exist_ok=True)
    predictions = []
    members = []
    for position, result in enumerate(selected, start=1):
        model = _fit_final(
            X,
            labels,
            dates,
            fit_index,
            spec_by_name[result["name"]],
            result,
            threads,
        )
        path = os.path.join(
            output_dir,
            f"return_rank_{position}_{result['name']}_s{result['seed']}.txt",
        )
        model.save_model(path)
        prediction = model.predict(X[holdout_index])
        predictions.append(prediction)
        members.append({
            **result,
            "model_file": os.path.basename(path),
            "holdout": top_k_return_metrics(
                dates[holdout_index],
                returns[holdout_index],
                prediction,
            ),
        })
    ensemble = np.mean(predictions, axis=0)
    report = {
        "schema_version": 1,
        "run_type": "36-factor-5d-return-ranker",
        "dataset": {
            "samples": int(len(X)),
            "stocks": int(len(np.unique(codes))),
            "features": feature_names,
        },
        "split": split,
        "search_results": sorted(
            results,
            key=lambda item: item["calibration"]["selection_score"],
            reverse=True,
        ),
        "members": members,
        "ensemble_holdout": top_k_return_metrics(
            dates[holdout_index],
            returns[holdout_index],
            ensemble,
        ),
        "elapsed_seconds": round(time.time() - started, 3),
        "production_promoted": False,
    }
    with open(
        os.path.join(output_dir, "return_rank_report.json"),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    np.savez_compressed(
        os.path.join(output_dir, "return_rank_predictions.npz"),
        dates=dates[holdout_index],
        codes=codes[holdout_index],
        actual_return=returns[holdout_index],
        prediction=ensemble.astype(np.float32),
    )
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--returns", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--seeds", default="42,137,2026")
    parser.add_argument(
        "--threads",
        type=int,
        default=max(1, (os.cpu_count() or 2) - 2),
    )
    args = parser.parse_args()
    report = train_return_ranker(
        args.base,
        args.returns,
        args.out_dir,
        seeds=[int(value) for value in args.seeds.split(",")],
        threads=args.threads,
    )
    print(json.dumps({
        "ensemble_holdout": report["ensemble_holdout"],
        "elapsed_seconds": report["elapsed_seconds"],
    }, ensure_ascii=False, indent=2))
    print("TRAIN_36_RETURN_RANK_OK")


if __name__ == "__main__":
    main()
