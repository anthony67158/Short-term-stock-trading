"""CPU-only challenger search for the production 36-factor model."""

import argparse
import json
import os
import time

import numpy as np
from time_splits import (
    three_way_purged_split as shared_three_way_purged_split,
)


def three_way_purged_split(
    dates,
    *,
    calibration_fraction=0.15,
    holdout_fraction=0.15,
    purge_dates=5,
):
    return shared_three_way_purged_split(
        dates,
        calibration_fraction=calibration_fraction,
        holdout_fraction=holdout_fraction,
        purge_dates=purge_dates,
    )


def date_grouped_indices(dates, indices):
    dates = np.asarray(dates).astype(str)
    indices = np.asarray(indices, dtype=np.int64)
    if dates.ndim != 1 or indices.ndim != 1:
        raise ValueError("dates and indices must be one-dimensional")
    if np.any(indices < 0) or np.any(indices >= len(dates)):
        raise ValueError("indices are outside dates")
    ordered = indices[np.argsort(dates[indices], kind="stable")]
    _values, counts = np.unique(dates[ordered], return_counts=True)
    return ordered, counts.astype(int).tolist()


def daily_top_k_precision(dates, labels, scores, *, top_k=3):
    dates = np.asarray(dates).astype(str)
    labels = np.asarray(labels, dtype=int)
    scores = np.asarray(scores, dtype=float)
    if not (dates.shape == labels.shape == scores.shape):
        raise ValueError("dates, labels, and scores must have equal shapes")
    if not isinstance(top_k, int) or top_k < 1:
        raise ValueError("top_k must be a positive integer")
    selected = []
    for date in np.unique(dates):
        indices = np.flatnonzero(dates == date)
        order = np.argsort(-scores[indices], kind="stable")
        selected.extend(indices[order[:top_k]])
    selected = np.asarray(selected, dtype=np.int64)
    precision = float(labels[selected].mean()) if len(selected) else 0.0
    base_rate = float(labels.mean()) if len(labels) else 0.0
    return {
        "precision": precision,
        "base_rate": base_rate,
        "lift": precision / base_rate if base_rate > 0 else 0.0,
        "selected": int(len(selected)),
        "dates": int(len(np.unique(dates))),
    }


def return_relevance_labels(dates, returns, *, levels=5):
    dates = np.asarray(dates).astype(str)
    returns = np.asarray(returns, dtype=float)
    if dates.shape != returns.shape or dates.ndim != 1:
        raise ValueError("dates and returns must be equal one-dimensional arrays")
    if not isinstance(levels, int) or levels < 2:
        raise ValueError("levels must be an integer of at least two")
    if not np.isfinite(returns).all():
        raise ValueError("returns must be finite")
    labels = np.empty(len(returns), dtype=np.int8)
    for date in np.unique(dates):
        indices = np.flatnonzero(dates == date)
        ordered = indices[np.argsort(returns[indices], kind="stable")]
        rank = np.arange(len(ordered))
        labels[ordered] = np.minimum(
            levels - 1,
            rank * levels // len(ordered),
        )
    return labels


BASE_PARAMS = {
    "objective": "binary",
    "metric": "auc",
    "boosting_type": "gbdt",
    "num_leaves": 63,
    "max_depth": 7,
    "learning_rate": 0.015,
    "feature_fraction": 0.7,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "min_data_in_leaf": 150,
    "lambda_l1": 1.0,
    "lambda_l2": 2.0,
    "feature_pre_filter": False,
    "verbosity": -1,
}


def candidate_specs():
    return [
        {"name": "baseline", "kind": "binary", "params": {}},
        {
            "name": "compact_regularized",
            "kind": "binary",
            "params": {
                "num_leaves": 31,
                "max_depth": 6,
                "min_data_in_leaf": 300,
                "lambda_l1": 2.0,
                "lambda_l2": 5.0,
                "feature_fraction": 0.85,
            },
        },
        {
            "name": "wide_regularized",
            "kind": "binary",
            "params": {
                "num_leaves": 127,
                "max_depth": 9,
                "min_data_in_leaf": 300,
                "lambda_l1": 2.0,
                "lambda_l2": 6.0,
                "feature_fraction": 0.8,
            },
        },
        {
            "name": "wide_conservative",
            "kind": "binary",
            "params": {
                "num_leaves": 127,
                "max_depth": 10,
                "min_data_in_leaf": 600,
                "lambda_l1": 3.0,
                "lambda_l2": 8.0,
                "feature_fraction": 0.9,
                "bagging_fraction": 0.9,
            },
        },
        {
            "name": "deep_63",
            "kind": "binary",
            "params": {
                "num_leaves": 63,
                "max_depth": 9,
                "min_data_in_leaf": 250,
                "feature_fraction": 0.9,
                "lambda_l2": 5.0,
            },
        },
        {
            "name": "slow_leafwise",
            "kind": "binary",
            "params": {
                "num_leaves": 63,
                "max_depth": -1,
                "learning_rate": 0.01,
                "min_data_in_leaf": 500,
                "lambda_l1": 2.0,
                "lambda_l2": 8.0,
                "feature_fraction": 0.9,
            },
        },
        {
            "name": "extra_trees",
            "kind": "binary",
            "params": {
                "extra_trees": True,
                "num_leaves": 63,
                "max_depth": 8,
                "min_data_in_leaf": 250,
                "feature_fraction": 0.9,
                "lambda_l2": 5.0,
            },
        },
        {
            "name": "rank_compact",
            "kind": "rank",
            "params": {
                "num_leaves": 31,
                "max_depth": 6,
                "min_data_in_leaf": 300,
                "feature_fraction": 0.85,
                "lambda_l2": 5.0,
            },
        },
        {
            "name": "rank_63",
            "kind": "rank",
            "params": {
                "num_leaves": 63,
                "max_depth": 8,
                "min_data_in_leaf": 300,
                "feature_fraction": 0.9,
                "lambda_l2": 6.0,
            },
        },
        {
            "name": "rank_wide",
            "kind": "rank",
            "params": {
                "num_leaves": 127,
                "max_depth": 9,
                "min_data_in_leaf": 500,
                "feature_fraction": 0.9,
                "lambda_l1": 2.0,
                "lambda_l2": 8.0,
            },
        },
    ]


def _params_for(spec, seed, threads):
    params = {
        **BASE_PARAMS,
        **spec["params"],
        "seed": seed,
        "feature_fraction_seed": seed,
        "bagging_seed": seed,
        "data_random_seed": seed,
        "num_threads": threads,
        "deterministic": True,
        "force_col_wise": True,
    }
    if spec["kind"] == "rank":
        params.update({
            "objective": "lambdarank",
            "metric": "ndcg",
            "ndcg_eval_at": [3, 5],
            "label_gain": [0, 1],
        })
    return params


def _datasets(X, y, dates, train_index, valid_index, kind):
    import lightgbm as lgb

    if kind == "rank":
        train_order, train_groups = date_grouped_indices(dates, train_index)
        valid_order, valid_groups = date_grouped_indices(dates, valid_index)
        train = lgb.Dataset(
            X[train_order],
            y[train_order],
            group=train_groups,
        )
        valid = lgb.Dataset(
            X[valid_order],
            y[valid_order],
            group=valid_groups,
            reference=train,
        )
        return train, valid
    train = lgb.Dataset(X[train_index], y[train_index])
    valid = lgb.Dataset(X[valid_index], y[valid_index], reference=train)
    return train, valid


def _score(labels, dates, prediction):
    from sklearn.metrics import roc_auc_score

    top3 = daily_top_k_precision(dates, labels, prediction, top_k=3)
    auc = float(roc_auc_score(labels, prediction))
    return {
        "auc": auc,
        "top3": top3,
        "selection_score": 0.75 * auc + 0.25 * top3["precision"],
    }


def train_search_candidate(
    X,
    y,
    dates,
    train_index,
    valid_index,
    spec,
    *,
    seed,
    threads,
):
    import lightgbm as lgb

    params = _params_for(spec, seed, threads)
    train, valid = _datasets(
        X,
        y,
        dates,
        train_index,
        valid_index,
        spec["kind"],
    )
    model = lgb.train(
        params,
        train,
        num_boost_round=2500,
        valid_sets=[valid],
        callbacks=[
            lgb.early_stopping(120, verbose=False),
            lgb.log_evaluation(0),
        ],
    )
    prediction = model.predict(
        X[valid_index],
        num_iteration=model.best_iteration,
    )
    return {
        "name": spec["name"],
        "kind": spec["kind"],
        "seed": seed,
        "iterations": int(model.best_iteration or 300),
        "params": spec["params"],
        **_score(y[valid_index], dates[valid_index], prediction),
    }


def fit_final_candidate(
    X,
    y,
    dates,
    fit_index,
    spec,
    search_result,
    *,
    threads,
):
    import lightgbm as lgb

    params = _params_for(spec, search_result["seed"], threads)
    if spec["kind"] == "rank":
        ordered, groups = date_grouped_indices(dates, fit_index)
        dataset = lgb.Dataset(X[ordered], y[ordered], group=groups)
    else:
        dataset = lgb.Dataset(X[fit_index], y[fit_index])
    return lgb.train(
        params,
        dataset,
        num_boost_round=search_result["iterations"],
    )


def run_search(
    dataset_path,
    output_dir,
    *,
    seeds,
    threads,
    max_candidates=None,
):
    with np.load(dataset_path, allow_pickle=True) as data:
        X = data["X"].astype(np.float32)
        y = data["y"].astype(int)
        dates = data["dates"].astype(str)
        codes = data["codes"].astype(str)
        feature_names = [str(value) for value in data["feat_names"]]
    if X.ndim != 2 or X.shape[1] != 36 or len(feature_names) != 36:
        raise ValueError("challenger requires the exact 36-factor dataset")
    if not set(np.unique(y)).issubset({0, 1}):
        raise ValueError("binary target must contain only zero and one")

    train_index, calibration_index, holdout_index, split = (
        three_way_purged_split(dates)
    )
    specs = candidate_specs()
    if max_candidates is not None:
        specs = specs[:max_candidates]
    results = []
    started = time.time()
    for spec in specs:
        for seed in seeds:
            result = train_search_candidate(
                X,
                y,
                dates,
                train_index,
                calibration_index,
                spec,
                seed=seed,
                threads=threads,
            )
            results.append(result)
            print(
                f"[calibration] {result['name']} seed={seed} "
                f"auc={result['auc']:.6f} "
                f"top3={result['top3']['precision']:.4f} "
                f"iter={result['iterations']}",
                flush=True,
            )

    binary_results = sorted(
        (item for item in results if item["kind"] == "binary"),
        key=lambda item: item["selection_score"],
        reverse=True,
    )
    rank_results = sorted(
        (item for item in results if item["kind"] == "rank"),
        key=lambda item: item["selection_score"],
        reverse=True,
    )
    if not binary_results:
        raise RuntimeError("search produced no binary candidates")
    selected_binary = binary_results[:min(3, len(binary_results))]
    selected_rank = rank_results[:min(3, len(rank_results))]
    spec_by_name = {item["name"]: item for item in specs}
    first_holdout_purge = split["holdout_purge_dates"][0]
    fit_index = np.flatnonzero(dates < first_holdout_purge)

    os.makedirs(output_dir, exist_ok=True)
    binary_predictions = []
    final_models = []
    for position, result in enumerate(selected_binary, start=1):
        model = fit_final_candidate(
            X,
            y,
            dates,
            fit_index,
            spec_by_name[result["name"]],
            result,
            threads=threads,
        )
        model_path = os.path.join(
            output_dir,
            f"ensemble_{position}_{result['name']}_s{result['seed']}.txt",
        )
        model.save_model(model_path)
        prediction = model.predict(X[holdout_index])
        binary_predictions.append(prediction)
        final_models.append({
            **result,
            "model_file": os.path.basename(model_path),
            "holdout": _score(
                y[holdout_index],
                dates[holdout_index],
                prediction,
            ),
        })

    ensemble_prediction = np.mean(binary_predictions, axis=0)
    ensemble_metrics = _score(
        y[holdout_index],
        dates[holdout_index],
        ensemble_prediction,
    )
    rank_final = None
    rank_prediction = None
    if selected_rank:
        rank_predictions = []
        rank_members = []
        for position, result in enumerate(selected_rank, start=1):
            model = fit_final_candidate(
                X,
                y,
                dates,
                fit_index,
                spec_by_name[result["name"]],
                result,
                threads=threads,
            )
            model_path = os.path.join(
                output_dir,
                f"rank_{position}_{result['name']}_s{result['seed']}.txt",
            )
            model.save_model(model_path)
            member_prediction = model.predict(X[holdout_index])
            rank_predictions.append(member_prediction)
            rank_members.append({
                **result,
                "model_file": os.path.basename(model_path),
                "holdout": _score(
                    y[holdout_index],
                    dates[holdout_index],
                    member_prediction,
                ),
            })
        rank_prediction = np.mean(rank_predictions, axis=0)
        rank_final = {
            "members": rank_members,
            "holdout": _score(
                y[holdout_index],
                dates[holdout_index],
                rank_prediction,
            ),
        }

    baseline_final = next(
        item["holdout"]
        for item in final_models
        if item["name"] == "baseline"
    ) if any(item["name"] == "baseline" for item in final_models) else None
    report = {
        "schema_version": 1,
        "run_type": "36-factor-cpu-max-search",
        "dataset": {
            "samples": int(len(X)),
            "stocks": int(len(np.unique(codes))),
            "features": feature_names,
            "positive_rate": float(y.mean()),
        },
        "split": split,
        "seeds": seeds,
        "search_results": sorted(
            results,
            key=lambda item: item["selection_score"],
            reverse=True,
        ),
        "selected_binary": final_models,
        "ensemble_holdout": ensemble_metrics,
        "rank_holdout": rank_final,
        "fair_baseline_holdout": baseline_final,
        "elapsed_seconds": round(time.time() - started, 3),
        "production_promoted": False,
    }
    with open(
        os.path.join(output_dir, "training_report.json"),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    prediction_payload = {
        "dates": dates[holdout_index],
        "codes": codes[holdout_index],
        "actual": y[holdout_index],
        "ensemble_prediction": ensemble_prediction.astype(np.float32),
    }
    if rank_prediction is not None:
        prediction_payload["rank_prediction"] = rank_prediction.astype(
            np.float32
        )
    np.savez_compressed(
        os.path.join(output_dir, "holdout_predictions.npz"),
        **prediction_payload,
    )
    return report


def main():
    parser = argparse.ArgumentParser(
        description="CPU-only search for a stronger 36-factor challenger",
    )
    parser.add_argument("--data", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--seeds", default="42,137,2026")
    parser.add_argument(
        "--threads",
        type=int,
        default=max(1, (os.cpu_count() or 2) - 2),
    )
    parser.add_argument("--max-candidates", type=int)
    args = parser.parse_args()
    seeds = [int(value) for value in args.seeds.split(",") if value.strip()]
    report = run_search(
        args.data,
        args.out_dir,
        seeds=seeds,
        threads=args.threads,
        max_candidates=args.max_candidates,
    )
    print(json.dumps({
        "ensemble_holdout": report["ensemble_holdout"],
        "rank_holdout": report["rank_holdout"],
        "elapsed_seconds": report["elapsed_seconds"],
    }, ensure_ascii=False, indent=2))
    print("TRAIN_36_MAX_OK")


if __name__ == "__main__":
    main()
