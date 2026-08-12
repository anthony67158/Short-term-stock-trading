"""Evaluate lagged Tushare features on a small fixed V2.1 holdout panel."""

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


HEADS = ("next30m", "sessionClose")
CANDIDATE_COLUMNS = {
    "stock_flow": (0, 1, 2, 3),
    "market_flow": (4, 5),
    "stock_and_market_flow": (0, 1, 2, 3, 4, 5),
}
L2_CANDIDATES = (0.1, 1.0, 10.0, 100.0)


def chronological_split(
    dates,
    *,
    calibration_dates=18,
    test_dates=20,
    purge_dates=2,
):
    dates = np.asarray(dates).astype(str)
    unique = sorted(set(dates))
    required = calibration_dates + test_dates + 2 * purge_dates + 1
    if len(unique) < required:
        raise ValueError("交易日不足以支持训练/校准/净化/测试切分")
    test_start = len(unique) - test_dates
    second_purge_start = test_start - purge_dates
    calibration_start = second_purge_start - calibration_dates
    first_purge_start = calibration_start - purge_dates
    train_dates = unique[:first_purge_start]
    first_purge = unique[first_purge_start:calibration_start]
    calibration_values = unique[calibration_start:second_purge_start]
    second_purge = unique[second_purge_start:test_start]
    test_values = unique[test_start:]
    return (
        np.flatnonzero(np.isin(dates, train_dates)),
        np.flatnonzero(np.isin(dates, calibration_values)),
        np.flatnonzero(np.isin(dates, test_values)),
        {
            "train_dates": [train_dates[0], train_dates[-1]],
            "calibration_dates": [
                calibration_values[0],
                calibration_values[-1],
            ],
            "test_dates": [test_values[0], test_values[-1]],
            "purged_dates": first_purge + second_purge,
        },
    )


def fit_weighted_ridge_classifier(features, labels, *, l2):
    values = np.asarray(features, dtype=np.float64)
    labels = np.asarray(labels, dtype=int)
    if values.ndim != 2 or labels.shape != (len(values),) or not len(values):
        raise ValueError("岭分类器训练数据无效")
    if not set(np.unique(labels)).issubset({0, 1, 2}):
        raise ValueError("岭分类器标签必须是0/1/2")
    mean = values.mean(axis=0)
    std = values.std(axis=0)
    std = np.where(std > 1e-8, std, 1.0)
    normalized = (values - mean) / std
    design = np.concatenate(
        (np.ones((len(values), 1)), normalized),
        axis=1,
    )
    counts = np.bincount(labels, minlength=3).astype(np.float64)
    class_weights = len(labels) / (3.0 * np.maximum(counts, 1.0))
    sample_weights = class_weights[labels]
    weighted_design = design * np.sqrt(sample_weights)[:, None]
    targets = np.eye(3, dtype=np.float64)[labels]
    weighted_targets = targets * np.sqrt(sample_weights)[:, None]
    penalty = np.eye(design.shape[1], dtype=np.float64) * float(l2)
    penalty[0, 0] = 0.0
    gram = np.einsum(
        "ni,nj->ij",
        weighted_design,
        weighted_design,
        optimize=True,
    )
    cross = np.einsum(
        "ni,nj->ij",
        weighted_design,
        weighted_targets,
        optimize=True,
    )
    coefficients = np.linalg.solve(
        gram + penalty,
        cross,
    )
    return {
        "mean": mean,
        "std": std,
        "coefficients": coefficients,
    }


def predict_ridge_probabilities(model, features):
    values = np.asarray(features, dtype=np.float64)
    normalized = (values - model["mean"]) / model["std"]
    design = np.concatenate(
        (np.ones((len(values), 1)), normalized),
        axis=1,
    )
    scores = np.einsum(
        "ni,ij->nj",
        design,
        model["coefficients"],
        optimize=True,
    )
    scores -= scores.max(axis=1, keepdims=True)
    probabilities = np.exp(scores)
    return probabilities / probabilities.sum(axis=1, keepdims=True)


def classification_metrics(labels, probabilities):
    labels = np.asarray(labels, dtype=int)
    probabilities = np.asarray(probabilities, dtype=np.float64)
    predictions = probabilities.argmax(axis=1)
    recalls = []
    f1_values = []
    counts = {}
    for label in range(3):
        selected = labels == label
        counts[str(label)] = int(selected.sum())
        recalls.append(
            float(np.mean(predictions[selected] == label))
            if np.any(selected)
            else 0.0
        )
        true_positive = np.sum((labels == label) & (predictions == label))
        false_positive = np.sum((labels != label) & (predictions == label))
        false_negative = np.sum((labels == label) & (predictions != label))
        denominator = 2 * true_positive + false_positive + false_negative
        f1_values.append(
            float(2 * true_positive / denominator)
            if denominator
            else 0.0
        )
    selected_probability = probabilities[
        np.arange(len(labels)),
        labels,
    ]
    return {
        "balanced_accuracy": float(np.mean(recalls)),
        "macro_f1": float(np.mean(f1_values)),
        "log_loss": float(
            -np.mean(np.log(np.clip(selected_probability, 1e-12, 1.0)))
        ),
        "class_counts": counts,
    }


def _probability_features(probabilities):
    values = np.asarray(probabilities, dtype=np.float64)
    return np.log(np.clip(values, 1e-6, 1.0))


def _fit_best_l2(train_features, train_labels, calibration_features,
                 calibration_labels):
    best = None
    for l2 in L2_CANDIDATES:
        model = fit_weighted_ridge_classifier(
            train_features,
            train_labels,
            l2=l2,
        )
        metrics = classification_metrics(
            calibration_labels,
            predict_ridge_probabilities(model, calibration_features),
        )
        candidate = (metrics["balanced_accuracy"], -metrics["log_loss"], l2)
        if best is None or candidate > best["rank"]:
            best = {
                "rank": candidate,
                "l2": l2,
                "model": model,
                "metrics": metrics,
            }
    return best


def select_candidate(candidates):
    if not candidates:
        raise ValueError("没有外生特征候选")
    return max(
        candidates,
        key=lambda name: (
            np.mean([
                candidates[name][head]["balanced_accuracy"]
                for head in HEADS
            ]),
            name,
        ),
    )


def _session_metrics(labels, probabilities, buckets):
    result = {}
    for bucket in sorted(set(buckets)):
        selected = buckets == bucket
        result[str(bucket)] = classification_metrics(
            labels[selected],
            probabilities[selected],
        )
    return result


def _verdict(baseline, augmented):
    improvement = {
        head: (
            augmented[head]["balanced_accuracy"]
            - baseline[head]["balanced_accuracy"]
        )
        for head in HEADS
    }
    mean = float(np.mean(list(improvement.values())))
    accepted = all(value >= 0.005 for value in improvement.values()) and mean >= 0.01
    return {
        "decision": "expand_research" if accepted else "reject",
        "head_improvement": improvement,
        "mean_improvement": mean,
        "production_eligible": False,
        "reason": (
            "双头均改善，值得扩大样本复验"
            if accepted
            else "双头未同时达到小样本增量门槛，不扩大训练"
        ),
    }


def evaluate_pilot(
    predictions_path,
    cache_path,
    *,
    max_codes=24,
    max_dates=90,
):
    with np.load(predictions_path, allow_pickle=False) as data:
        all_codes = data["codes"].astype(str)
        all_dates = data["dates"].astype(str)
        selected = select_pilot_indices(
            all_codes,
            all_dates,
            max_codes=max_codes,
            max_dates=max_dates,
        )
        codes = all_codes[selected]
        dates = all_dates[selected]
        buckets = data["session_bucket"][selected].astype(str)
        labels = {
            "next30m": data["actual_next30m"][selected].astype(int),
            "sessionClose": data["actual_session_close"][selected].astype(int),
        }
        probabilities = {
            "next30m": data["next30m_prob"][selected].astype(np.float64),
            "sessionClose": data["session_close_prob"][selected].astype(
                np.float64
            ),
        }
    with open(cache_path, encoding="utf-8") as handle:
        cache = json.load(handle)
    exogenous, coverage = build_exogenous_features(codes, dates, cache)
    train, calibration, test, split = chronological_split(dates)

    baseline_selection = {}
    baseline_test = {}
    raw_test = {}
    for head in HEADS:
        base = _probability_features(probabilities[head])
        selected_l2 = _fit_best_l2(
            base[train],
            labels[head][train],
            base[calibration],
            labels[head][calibration],
        )
        baseline_selection[head] = selected_l2
        baseline_probability = predict_ridge_probabilities(
            selected_l2["model"],
            base[test],
        )
        baseline_test[head] = {
            "probabilities": baseline_probability,
            "metrics": classification_metrics(
                labels[head][test],
                baseline_probability,
            ),
        }
        raw_test[head] = classification_metrics(
            labels[head][test],
            probabilities[head][test],
        )

    candidate_selection = {}
    candidate_models = {}
    for name, columns in CANDIDATE_COLUMNS.items():
        candidate_selection[name] = {}
        candidate_models[name] = {}
        selected_exogenous = exogenous[:, columns]
        for head in HEADS:
            base = _probability_features(probabilities[head])
            augmented = np.concatenate(
                (base, selected_exogenous),
                axis=1,
            )
            best = _fit_best_l2(
                augmented[train],
                labels[head][train],
                augmented[calibration],
                labels[head][calibration],
            )
            candidate_selection[name][head] = best["metrics"]
            candidate_models[name][head] = {
                **best,
                "features": augmented,
            }
    chosen = select_candidate(candidate_selection)
    augmented_test = {}
    for head in HEADS:
        candidate = candidate_models[chosen][head]
        test_probability = predict_ridge_probabilities(
            candidate["model"],
            candidate["features"][test],
        )
        augmented_test[head] = {
            "probabilities": test_probability,
            "metrics": classification_metrics(
                labels[head][test],
                test_probability,
            ),
        }

    baseline_metrics = {
        head: baseline_test[head]["metrics"]
        for head in HEADS
    }
    augmented_metrics = {
        head: augmented_test[head]["metrics"]
        for head in HEADS
    }
    return {
        "experiment": "v2.1-tushare-exogenous-stacked-small-pilot",
        "small_sample_only": True,
        "samples": int(len(selected)),
        "codes": int(len(np.unique(codes))),
        "dates": int(len(np.unique(dates))),
        "split": split,
        "coverage": coverage,
        "candidate_selection_source": "calibration_only",
        "candidate_calibration_metrics": candidate_selection,
        "selected_candidate": chosen,
        "selected_feature_names": [
            EXOGENOUS_FEATURE_NAMES[index]
            for index in CANDIDATE_COLUMNS[chosen]
        ],
        "raw_model_test_metrics": raw_test,
        "baseline_test_metrics": baseline_metrics,
        "augmented_test_metrics": augmented_metrics,
        "sessions": {
            "baseline": {
                head: _session_metrics(
                    labels[head][test],
                    baseline_test[head]["probabilities"],
                    buckets[test],
                )
                for head in HEADS
            },
            "augmented": {
                head: _session_metrics(
                    labels[head][test],
                    augmented_test[head]["probabilities"],
                    buckets[test],
                )
                for head in HEADS
            },
        },
        "selected_l2": {
            "baseline": {
                head: baseline_selection[head]["l2"]
                for head in HEADS
            },
            "augmented": {
                head: candidate_models[chosen][head]["l2"]
                for head in HEADS
            },
        },
        "verdict": _verdict(baseline_metrics, augmented_metrics),
        "evaluated_at": int(time.time()),
    }


def main():
    parser = argparse.ArgumentParser(
        description="用固定留出预测验证Tushare资金流的独立增量",
    )
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-codes", type=int, default=24)
    parser.add_argument("--max-dates", type=int, default=90)
    args = parser.parse_args()
    result = evaluate_pilot(
        args.predictions,
        args.cache,
        max_codes=args.max_codes,
        max_dates=args.max_dates,
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
        "selected_candidate": result["selected_candidate"],
        "baseline": result["baseline_test_metrics"],
        "augmented": result["augmented_test_metrics"],
        "verdict": result["verdict"],
    }, ensure_ascii=False))
    print("INTRADAY_V21_EXOGENOUS_STACKED_PILOT_OK")


if __name__ == "__main__":
    main()
