"""Run an offline, same-split V3 model bake-off without publishing models."""

import argparse
import hashlib
import json
import os
import pickle
import platform
import time

import numpy as np

from opportunity_evaluation import (
    apply_probability_calibrator,
    binary_metrics,
    block_bootstrap_lower_bound,
    fit_probability_calibrator,
    ranking_metrics,
    regression_metrics,
)
from train_opportunity_score import (
    _apply_rank_value_calibrator,
    _fit_rank_value_calibrator,
    _training_weights,
)
from v3_poc_dataset import build_poc_dataset, interval_expanding_folds


POC_SCHEMA_VERSION = "v3-model-bakeoff.v1"
FAMILY_NAMES = ("lightgbm", "catboost")


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _percentile_summary(values):
    data = np.asarray(values, dtype=np.float64)
    return {
        "min": round(float(data.min()), 6),
        "p01": round(float(np.percentile(data, 1)), 6),
        "p10": round(float(np.percentile(data, 10)), 6),
        "median": round(float(np.median(data)), 6),
        "mean": round(float(data.mean()), 6),
        "p90": round(float(np.percentile(data, 90)), 6),
        "p99": round(float(np.percentile(data, 99)), 6),
        "max": round(float(data.max()), 6),
    }


def clip_labels(values, low=0.005, high=0.995):
    data = np.asarray(values, dtype=np.float64)
    lower, upper = np.quantile(data, [low, high])
    return np.clip(data, lower, upper), {
        "lower": round(float(lower), 6),
        "upper": round(float(upper), 6),
    }


def relevance_labels(values, thresholds=None):
    data = np.nan_to_num(
        np.asarray(values, dtype=np.float64),
        nan=0.0,
    )
    if thresholds is None:
        positive = data[data > 0]
        if not len(positive):
            raise ValueError("排序训练集没有正收益样本")
        thresholds = np.quantile(positive, [0.5, 0.8]).astype(float)
    labels = np.ones(len(data), dtype=np.int32)
    labels[data < 0] = 0
    labels[data > 0] = 2
    labels[data > thresholds[0]] = 3
    labels[data > thresholds[1]] = 4
    return labels, [round(float(value), 6) for value in thresholds]


def compose_expected_net_r(
    win_probability,
    win_payoff,
    loss_payoff,
):
    probability = np.clip(
        np.asarray(win_probability, dtype=np.float64),
        0,
        1,
    )
    positive = np.maximum(
        0,
        np.asarray(win_payoff, dtype=np.float64),
    )
    negative = np.minimum(
        0,
        np.asarray(loss_payoff, dtype=np.float64),
    )
    if probability.shape != positive.shape or negative.shape != positive.shape:
        raise ValueError("POC动作价值数组维度不一致")
    return probability * positive + (1 - probability) * negative


def active_feature_mask(X):
    matrix = np.asarray(X, dtype=np.float64)
    return np.ptp(matrix, axis=0) > 1e-12


def rank_training_data(dataset, indices, labels, feature_mask):
    dates = dataset["dates"][indices].astype(str)
    codes = dataset["codes"][indices].astype(str)
    order = np.lexsort((codes, dates))
    selected = indices[order]
    sorted_dates = dates[order]
    _, group_ids, group_sizes = np.unique(
        sorted_dates,
        return_inverse=True,
        return_counts=True,
    )
    return {
        "X": dataset["X"][selected][:, feature_mask],
        "y": labels[order],
        "qid": group_ids.astype(np.int32),
        "group": group_sizes.astype(np.int32),
    }


class LightGbmFamily:
    name = "lightgbm"

    def __init__(self, estimators, threads, seed):
        import lightgbm as lgb

        self.lgb = lgb
        self.version = lgb.__version__
        self.common = {
            "n_estimators": estimators,
            "learning_rate": 0.04,
            "num_leaves": 31,
            "max_depth": 6,
            "min_child_samples": 60,
            "subsample": 0.85,
            "subsample_freq": 1,
            "colsample_bytree": 0.85,
            "reg_alpha": 0.3,
            "reg_lambda": 1.0,
            "random_state": seed,
            "n_jobs": threads,
            "verbosity": -1,
        }

    def classifier(self):
        return self.lgb.LGBMClassifier(objective="binary", **self.common)

    def regressor(self):
        return self.lgb.LGBMRegressor(
            objective="huber",
            alpha=0.9,
            **self.common,
        )

    def quantile(self):
        return self.lgb.LGBMRegressor(
            objective="quantile",
            alpha=0.1,
            **self.common,
        )

    def ranker(self):
        return self.lgb.LGBMRanker(
            objective="lambdarank",
            label_gain=[0, 1, 2, 4, 8],
            lambdarank_truncation_level=8,
            **self.common,
        )

    @staticmethod
    def fit_ranker(model, data):
        model.fit(data["X"], data["y"], group=data["group"])


class CatBoostFamily:
    name = "catboost"

    def __init__(self, estimators, threads, seed):
        import catboost

        self.cb = catboost
        self.version = catboost.__version__
        self.common = {
            "iterations": estimators,
            "learning_rate": 0.04,
            "depth": 6,
            "random_seed": seed,
            "thread_count": threads,
            "verbose": False,
            "allow_writing_files": False,
        }

    def classifier(self):
        return self.cb.CatBoostClassifier(
            loss_function="Logloss",
            **self.common,
        )

    def regressor(self):
        return self.cb.CatBoostRegressor(
            loss_function="Huber:delta=1.0",
            **self.common,
        )

    def quantile(self):
        return self.cb.CatBoostRegressor(
            loss_function="Quantile:alpha=0.1",
            **self.common,
        )

    def ranker(self):
        return self.cb.CatBoostRanker(
            loss_function="YetiRankPairwise",
            **self.common,
        )

    @staticmethod
    def fit_ranker(model, data):
        model.fit(data["X"], data["y"], group_id=data["qid"])


class XGBoostFamily:
    name = "xgboost"

    def __init__(self, estimators, threads, seed):
        import xgboost as xgb

        self.xgb = xgb
        self.version = xgb.__version__
        self.common = {
            "n_estimators": estimators,
            "learning_rate": 0.04,
            "max_depth": 6,
            "min_child_weight": 20,
            "subsample": 0.85,
            "colsample_bytree": 0.85,
            "reg_alpha": 0.3,
            "reg_lambda": 1.0,
            "random_state": seed,
            "n_jobs": threads,
            "tree_method": "hist",
        }

    def classifier(self):
        return self.xgb.XGBClassifier(
            objective="binary:logistic",
            eval_metric="logloss",
            **self.common,
        )

    def regressor(self):
        return self.xgb.XGBRegressor(
            objective="reg:pseudohubererror",
            huber_slope=1.0,
            **self.common,
        )

    def quantile(self):
        return self.xgb.XGBRegressor(
            objective="reg:quantileerror",
            quantile_alpha=0.1,
            **self.common,
        )

    def ranker(self):
        return self.xgb.XGBRanker(
            objective="rank:ndcg",
            eval_metric="ndcg@5",
            lambdarank_pair_method="topk",
            lambdarank_num_pair_per_sample=8,
            **self.common,
        )

    @staticmethod
    def fit_ranker(model, data):
        model.fit(data["X"], data["y"], qid=data["qid"])


def model_family(name, estimators, threads, seed):
    factories = {
        "lightgbm": LightGbmFamily,
        "catboost": CatBoostFamily,
        "xgboost": XGBoostFamily,
    }
    if name not in factories:
        raise ValueError(f"未知POC模型: {name}")
    return factories[name](estimators, threads, seed)


def _probability(model, X):
    values = np.asarray(model.predict_proba(X), dtype=np.float64)
    if values.ndim != 2 or values.shape[1] != 2:
        raise ValueError("POC分类模型概率维度无效")
    return np.clip(values[:, 1], 1e-8, 1 - 1e-8)


def constant_probability_metrics(train_labels, validation_labels):
    probability = float(np.mean(train_labels))
    values = np.full(
        len(validation_labels),
        np.clip(probability, 1e-8, 1 - 1e-8),
        dtype=np.float64,
    )
    return binary_metrics(validation_labels, values)


def _ranking(
    actual,
    scores,
    dataset,
    validation,
    *,
    eligible_mask=None,
):
    output = {}
    for top_k in (3, 5):
        metrics = ranking_metrics(
            actual > 0,
            actual,
            scores,
            dataset["dates"][validation],
            top_k=top_k,
            group_ids=dataset["codes"][validation],
            eligible_mask=eligible_mask,
        )
        output[f"top{top_k}"] = {
            **metrics,
            "netRLowerBound": block_bootstrap_lower_bound(
                metrics["daily_net_r"],
                samples=2000,
                random_state=42,
            ),
        }
    return output


def _latency_ms(models, X, ranker, repeats=20):
    sample = X[: min(240, len(X))]
    for model in models:
        model.predict(sample)
    ranker.predict(sample)
    durations = []
    for _ in range(repeats):
        started = time.perf_counter()
        for model in models:
            model.predict(sample)
        ranker.predict(sample)
        durations.append((time.perf_counter() - started) * 1000)
    return round(float(np.percentile(durations, 95)), 3)


def run_family_fold(family, dataset, fold):
    train = fold["train"]
    calibration = fold["calibration"]
    validation = fold["validation"]
    filled_train = train[np.isfinite(dataset["y_net_r"][train])]
    filled_calibration = calibration[
        np.isfinite(dataset["y_net_r"][calibration])
    ]
    filled_validation = validation[
        np.isfinite(dataset["y_net_r"][validation])
    ]
    mask = active_feature_mask(dataset["X"][train])
    X_train = dataset["X"][train][:, mask]
    X_calibration = dataset["X"][calibration][:, mask]
    X_validation = dataset["X"][validation][:, mask]
    X_filled_train = dataset["X"][filled_train][:, mask]
    X_filled_calibration = dataset["X"][filled_calibration][:, mask]
    positive_train = filled_train[
        dataset["y_net_r"][filled_train] > 0
    ]
    negative_train = filled_train[
        dataset["y_net_r"][filled_train] <= 0
    ]
    positive_net_r, positive_clipping = clip_labels(
        dataset["y_net_r"][positive_train],
    )
    negative_net_r, negative_clipping = clip_labels(
        dataset["y_net_r"][negative_train],
    )
    quantile_net_r, quantile_clipping = clip_labels(
        dataset["y_net_r"][filled_train],
    )
    rank_actual_train = np.nan_to_num(
        dataset["y_net_r"][train],
        nan=0.0,
    )
    rank_labels, relevance_thresholds = relevance_labels(
        rank_actual_train,
    )
    rank_data = rank_training_data(
        dataset,
        train,
        rank_labels,
        mask,
    )

    started = time.perf_counter()
    fill_model = family.classifier()
    fill_model.fit(
        X_train,
        dataset["y_fill"][train],
        sample_weight=_training_weights(
            dataset,
            train,
            dataset["y_fill"][train],
        ),
    )
    win_model = family.classifier()
    win_model.fit(
        X_filled_train,
        dataset["y_win"][filled_train],
        sample_weight=_training_weights(
            dataset,
            filled_train,
            dataset["y_win"][filled_train],
        ),
    )
    win_payoff_model = family.regressor()
    win_payoff_model.fit(
        dataset["X"][positive_train][:, mask],
        positive_net_r,
        sample_weight=_training_weights(dataset, positive_train),
    )
    loss_payoff_model = family.regressor()
    loss_payoff_model.fit(
        dataset["X"][negative_train][:, mask],
        negative_net_r,
        sample_weight=_training_weights(dataset, negative_train),
    )
    quantile_model = family.quantile()
    quantile_model.fit(
        X_filled_train,
        quantile_net_r,
        sample_weight=_training_weights(dataset, filled_train),
    )
    ranker = family.ranker()
    family.fit_ranker(ranker, rank_data)
    fit_seconds = time.perf_counter() - started

    fill_calibrator = fit_probability_calibrator(
        dataset["y_fill"][calibration],
        _probability(fill_model, X_calibration),
    )
    win_calibrator = fit_probability_calibrator(
        dataset["y_win"][filled_calibration].astype(np.int8),
        _probability(win_model, X_filled_calibration),
    )
    rank_calibration_scores = np.asarray(
        ranker.predict(X_calibration),
        dtype=np.float64,
    )
    rank_value_calibration = _fit_rank_value_calibrator(
        ranker.predict(X_filled_calibration),
        dataset["y_net_r"][filled_calibration],
    )
    fill_probability = apply_probability_calibrator(
        _probability(fill_model, X_validation),
        fill_calibrator,
    )
    win_probability_all = apply_probability_calibrator(
        _probability(win_model, X_validation),
        win_calibrator,
    )
    win_probability = win_probability_all[
        np.isfinite(dataset["y_net_r"][validation])
    ]
    win_payoff = np.asarray(
        win_payoff_model.predict(X_validation),
        dtype=np.float64,
    )
    loss_payoff = np.asarray(
        loss_payoff_model.predict(X_validation),
        dtype=np.float64,
    )
    expected_net_r = compose_expected_net_r(
        win_probability_all,
        win_payoff,
        loss_payoff,
    )
    rank_expected_net_r = _apply_rank_value_calibrator(
        rank_scores := np.asarray(
            ranker.predict(X_validation),
            dtype=np.float64,
        ),
        rank_value_calibration,
    )
    expected_net_r_filled = expected_net_r[
        np.isfinite(dataset["y_net_r"][validation])
    ]
    q10 = np.asarray(
        quantile_model.predict(X_validation),
        dtype=np.float64,
    )
    calibration_q10 = np.asarray(
        quantile_model.predict(X_filled_calibration),
        dtype=np.float64,
    )
    q10 += float(np.quantile(
        dataset["y_net_r"][filled_calibration] - calibration_q10,
        0.1,
    ))
    q10 = np.minimum(q10, expected_net_r)
    q10_filled = q10[np.isfinite(dataset["y_net_r"][validation])]
    actual_filled = dataset["y_net_r"][filled_validation]
    actual_all = np.nan_to_num(
        dataset["y_net_r"][validation],
        nan=0.0,
    )
    utility = fill_probability * expected_net_r
    formula_index = list(dataset["feature_names"].astype(str)).index(
        "formulaScore",
    )
    formula_scores = dataset["X"][validation, formula_index]
    models = (
        fill_model,
        win_model,
        win_payoff_model,
        loss_payoff_model,
        quantile_model,
    )
    fill_metrics = binary_metrics(
        dataset["y_fill"][validation],
        fill_probability,
    )
    fill_baseline = constant_probability_metrics(
        dataset["y_fill"][train],
        dataset["y_fill"][validation],
    )
    win_metrics = binary_metrics(
        dataset["y_win"][filled_validation].astype(np.int8),
        win_probability,
    )
    win_baseline = constant_probability_metrics(
        dataset["y_win"][filled_train].astype(np.int8),
        dataset["y_win"][filled_validation].astype(np.int8),
    )
    net_r_metrics = {
        **regression_metrics(actual_filled, expected_net_r_filled),
        "medianAbsoluteError": round(float(np.median(
            np.abs(expected_net_r_filled - actual_filled)
        )), 6),
    }
    baseline_net_r = np.full(
        len(actual_filled),
        float(np.median(dataset["y_net_r"][filled_train])),
        dtype=np.float64,
    )
    return {
        "metadata": {
            **fold["metadata"],
            "activeFeatures": int(mask.sum()),
            "labelClip": {
                "winPayoff": positive_clipping,
                "lossPayoff": negative_clipping,
                "quantile10": quantile_clipping,
            },
            "relevanceThresholds": relevance_thresholds,
        },
        "pFill": {
            **fill_metrics,
            "constantBaseline": fill_baseline,
            "brierSkill": round(
                1 - fill_metrics["brier"] / fill_baseline["brier"],
                6,
            ),
        },
        "pWinGivenFill": {
            **win_metrics,
            "constantBaseline": win_baseline,
            "brierSkill": round(
                1 - win_metrics["brier"] / win_baseline["brier"],
                6,
            ),
        },
        "expectedNetR": {
            **net_r_metrics,
            "constantMedianBaseline": regression_metrics(
                actual_filled,
                baseline_net_r,
            ),
            "maeSkill": round(
                1 - net_r_metrics["mae"]
                / regression_metrics(actual_filled, baseline_net_r)["mae"],
                6,
            ),
        },
        "quantile10": {
            "coverage": round(float(
                np.mean(actual_filled >= q10_filled)
            ), 6),
            "crossingRate": round(float(
                np.mean(q10_filled > expected_net_r_filled)
            ), 6),
        },
        "coverage": {
            "positiveExpected": round(float(
                np.mean(expected_net_r > 0)
            ), 6),
            "positiveQ10": round(float(np.mean(q10 > 0)), 6),
        },
        "ranking": {
            "utility": _ranking(
                actual_all,
                utility,
                dataset,
                validation,
                eligible_mask=expected_net_r > 0,
            ),
            "ranker": _ranking(
                actual_all,
                rank_scores,
                dataset,
                validation,
            ),
            "formulaScore": _ranking(
                actual_all,
                formula_scores,
                dataset,
                validation,
            ),
        },
        "_selection": {
            "validation": validation.astype(int).tolist(),
            "expectedNetR": expected_net_r.astype(float).tolist(),
            "rankerScore": rank_scores.astype(float).tolist(),
            "rankExpectedNetR":
                rank_expected_net_r.astype(float).tolist(),
            "calibration": calibration.astype(int).tolist(),
            "calibrationExpectedNetR": compose_expected_net_r(
                apply_probability_calibrator(
                    _probability(win_model, X_calibration),
                    win_calibrator,
                ),
                win_payoff_model.predict(X_calibration),
                loss_payoff_model.predict(X_calibration),
            ).astype(float).tolist(),
            "calibrationRankerScore":
                rank_calibration_scores.astype(float).tolist(),
            "calibrationRankExpectedNetR":
                _apply_rank_value_calibrator(
                    rank_calibration_scores,
                    rank_value_calibration,
                ).astype(float).tolist(),
        },
        "fitSeconds": round(fit_seconds, 3),
        "batch240P95Ms": _latency_ms(
            models,
            X_validation,
            ranker,
        ),
        "serializedBytes": len(pickle.dumps({
            "fill": fill_model,
            "win": win_model,
            "winPayoff": win_payoff_model,
            "lossPayoff": loss_payoff_model,
            "q10": quantile_model,
            "ranker": ranker,
        }, protocol=pickle.HIGHEST_PROTOCOL)),
    }


def _mean(values):
    clean = [
        float(value)
        for value in values
        if value is not None and np.isfinite(float(value))
    ]
    return round(float(np.mean(clean)), 6) if clean else None


def aggregate_family(folds):
    daily_utility = {}
    daily_ranker = {}
    for fold in folds:
        daily_utility.update(
            fold["ranking"]["utility"]["top5"]["daily_net_r"]
        )
        daily_ranker.update(
            fold["ranking"]["ranker"]["top5"]["daily_net_r"]
        )
    return {
        "pFillBrier": _mean([fold["pFill"]["brier"] for fold in folds]),
        "pFillBrierSkill": _mean([
            fold["pFill"]["brierSkill"] for fold in folds
        ]),
        "pWinBrier": _mean([
            fold["pWinGivenFill"]["brier"] for fold in folds
        ]),
        "pWinBrierSkill": _mean([
            fold["pWinGivenFill"]["brierSkill"] for fold in folds
        ]),
        "netRMae": _mean([
            fold["expectedNetR"]["mae"] for fold in folds
        ]),
        "netRMaeSkill": _mean([
            fold["expectedNetR"]["maeSkill"] for fold in folds
        ]),
        "netRRankCorrelation": _mean([
            fold["expectedNetR"]["rank_correlation"] for fold in folds
        ]),
        "q10Coverage": _mean([
            fold["quantile10"]["coverage"] for fold in folds
        ]),
        "positiveExpectedCoverage": _mean([
            fold["coverage"]["positiveExpected"] for fold in folds
        ]),
        "positiveQ10Coverage": _mean([
            fold["coverage"]["positiveQ10"] for fold in folds
        ]),
        "utilityTop5MeanNetR": _mean(daily_utility.values()),
        "utilityTop5LowerBound": block_bootstrap_lower_bound(
            daily_utility,
            samples=5000,
            random_state=42,
        ),
        "rankerTop5MeanNetR": _mean(daily_ranker.values()),
        "rankerTop5LowerBound": block_bootstrap_lower_bound(
            daily_ranker,
            samples=5000,
            random_state=42,
        ),
        "fitSeconds": round(sum(
            fold["fitSeconds"] for fold in folds
        ), 3),
        "batch240P95Ms": _mean([
            fold["batch240P95Ms"] for fold in folds
        ]),
        "serializedBytes": max(
            fold["serializedBytes"] for fold in folds
        ),
    }


def combine_action_value_and_ranker(dataset, lightgbm_folds, catboost_folds):
    folds = []
    daily = {}
    for action_fold, ranker_fold in zip(lightgbm_folds, catboost_folds):
        action = action_fold["_selection"]
        ranking = ranker_fold["_selection"]
        validation = np.asarray(action["validation"], dtype=np.int64)
        if validation.tolist() != ranking["validation"]:
            raise ValueError("动作价值与排序模型验证切分不一致")
        calibration = np.asarray(
            action["calibration"],
            dtype=np.int64,
        )
        if calibration.tolist() != ranking["calibration"]:
            raise ValueError("动作价值与排序模型校准切分不一致")
        calibration_action = np.asarray(
            action["calibrationExpectedNetR"],
            dtype=np.float64,
        )
        calibration_rank = np.asarray(
            ranking["calibrationRankExpectedNetR"],
            dtype=np.float64,
        )
        calibration_rank_score = np.asarray(
            ranking["calibrationRankerScore"],
            dtype=np.float64,
        )
        calibration_actual = np.nan_to_num(
            dataset["y_net_r"][calibration],
            nan=0.0,
        )
        blend_trials = []
        for weight in (0.0, 0.25, 0.5, 0.75, 1.0):
            expected = (
                (1 - weight) * calibration_action
                + weight * calibration_rank
            )
            metrics = _ranking(
                calibration_actual,
                calibration_rank_score,
                dataset,
                calibration,
                eligible_mask=expected > 0,
            )
            blend_trials.append({
                "weight": weight,
                "meanNetRAt5":
                    metrics["top5"]["mean_net_r_at_5"],
                "positiveExpectedCoverage": round(float(np.mean(
                    expected > 0
                )), 6),
            })
        eligible = [
            trial
            for trial in blend_trials
            if trial["positiveExpectedCoverage"] >= 0.02
        ] or blend_trials
        selected = max(
            eligible,
            key=lambda trial: (
                trial["meanNetRAt5"],
                -trial["weight"],
            ),
        )
        weight = selected["weight"]
        action_expected = np.asarray(
            action["expectedNetR"],
            dtype=np.float64,
        )
        rank_expected = np.asarray(
            ranking["rankExpectedNetR"],
            dtype=np.float64,
        )
        expected_net_r = (
            (1 - weight) * action_expected
            + weight * rank_expected
        )
        ranker_score = np.asarray(
            ranking["rankerScore"],
            dtype=np.float64,
        )
        actual = np.nan_to_num(
            dataset["y_net_r"][validation],
            nan=0.0,
        )
        metrics = _ranking(
            actual,
            ranker_score,
            dataset,
            validation,
            eligible_mask=expected_net_r > 0,
        )
        daily.update(metrics["top5"]["daily_net_r"])
        folds.append({
            "fold": action_fold["fold"],
            "validationStartDate":
                action_fold["metadata"]["validationStartDate"],
            "validationEndDate":
                action_fold["metadata"]["validationEndDate"],
            "positiveExpectedCoverage": round(float(np.mean(
                expected_net_r > 0
            )), 6),
            "rankBlendWeight": weight,
            "blendTrials": blend_trials,
            "ranking": metrics,
        })
    return {
        "folds": folds,
        "aggregate": {
            "top5MeanNetR": _mean(daily.values()),
            "top5LowerBound": block_bootstrap_lower_bound(
                daily,
                samples=5000,
                random_state=42,
            ),
            "positiveExpectedCoverage": _mean([
                fold["positiveExpectedCoverage"]
                for fold in folds
            ]),
        },
    }


def _markdown(report):
    rows = []
    for name, value in report["families"].items():
        summary = value["aggregate"]
        rows.append(
            f"| {name} | {summary['pFillBrier']:.4f} | "
            f"{summary['pWinBrier']:.4f} | {summary['netRMae']:.4f} | "
            f"{summary['utilityTop5MeanNetR']:.4f}R | "
            f"{summary['utilityTop5LowerBound']:.4f}R | "
            f"{summary['rankerTop5MeanNetR']:.4f}R | "
            f"{summary['positiveExpectedCoverage']:.1%} | "
            f"{summary['batch240P95Ms']:.1f}ms | "
            f"{summary['serializedBytes'] / 1024 / 1024:.1f}MB |"
        )
    return "\n".join([
        "# V3 双模型同口径 POC",
        "",
        f"- 状态：`{report['decision']['state']}`",
        f"- 数据摘要：`{report['dataset']['sha256']}`",
        f"- 样本：{report['dataset']['samples']}",
        f"- 成交标签：{report['dataset']['filledSamples']}",
        f"- 交易日：{report['dataset']['dates']}",
        f"- Fold：{report['dataset']['folds']}",
        "",
        "| 模型 | pFill Brier | pWin Brier | NetR MAE | Utility Top5 | Top5 下界 | Ranker Top5 | 正期望覆盖 | 240路径P95 | 模型体积 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        *rows,
        "",
        "## 决策",
        "",
        report["decision"]["reason"],
        "",
        "本报告仅为离线 POC，不会更新 OSS 模型或生产 `DIRECT` 指针。",
        "",
    ])


def run_bakeoff(
    input_path,
    output_directory,
    *,
    families=FAMILY_NAMES,
    folds_count=3,
    estimators=180,
    threads=4,
    seed=42,
):
    dataset = build_poc_dataset(input_path)
    folds = interval_expanding_folds(
        dataset,
        n_splits=folds_count,
    )
    filled = np.isfinite(dataset["y_net_r"])
    results = {}
    for name in families:
        family = model_family(name, estimators, threads, seed)
        fold_results = []
        for fold_number, fold in enumerate(folds, 1):
            value = run_family_fold(family, dataset, fold)
            value["fold"] = fold_number
            fold_results.append(value)
        results[name] = {
            "version": family.version,
            "folds": fold_results,
            "aggregate": aggregate_family(fold_results),
        }
    combination = None
    if "lightgbm" in results and "catboost" in results:
        combination = combine_action_value_and_ranker(
            dataset,
            results["lightgbm"]["folds"],
            results["catboost"]["folds"],
        )
    for family in results.values():
        for fold in family["folds"]:
            fold.pop("_selection", None)
    ranked = sorted(
        results.items(),
        key=lambda item: (
            item[1]["aggregate"]["utilityTop5LowerBound"]
            if item[1]["aggregate"]["utilityTop5LowerBound"] is not None
            else -float("inf"),
            item[1]["aggregate"]["utilityTop5MeanNetR"]
            if item[1]["aggregate"]["utilityTop5MeanNetR"] is not None
            else -float("inf"),
        ),
        reverse=True,
    )
    best_name, best = ranked[0]
    lower_bound = best["aggregate"]["utilityTop5LowerBound"]
    passed = lower_bound is not None and lower_bound > 0
    report = {
        "schemaVersion": POC_SCHEMA_VERSION,
        "generatedAt": int(time.time() * 1000),
        "runtime": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "estimators": int(estimators),
            "threads": int(threads),
            "seed": int(seed),
        },
        "dataset": {
            "sha256": _sha256(input_path),
            "samples": int(len(dataset["X"])),
            "filledSamples": int(filled.sum()),
            "dates": int(len(set(dataset["dates"].tolist()))),
            "features": int(dataset["X"].shape[1]),
            "folds": len(folds),
            "netR": _percentile_summary(
                dataset["y_net_r"][filled],
            ),
            "splits": [fold["metadata"] for fold in folds],
        },
        "families": results,
        "combination": combination,
        "decision": {
            "state": (
                "POC_WINNER_CANDIDATE"
                if passed
                else "NO_PRODUCTION_WINNER"
            ),
            "candidate": best_name if passed else None,
            "reason": (
                f"{best_name} 的跨窗口 Utility Top5 下界为正，"
                "可进入下一轮压力测试；尚未获得生产发布资格。"
                if passed
                else "没有模型同时证明跨窗口 Top5 费后净R下界为正；"
                "本轮不得替换生产模型。"
            ),
        },
    }
    os.makedirs(output_directory, exist_ok=True)
    with open(
        os.path.join(output_directory, "report.json"),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    with open(
        os.path.join(output_directory, "report.md"),
        "w",
        encoding="utf-8",
    ) as handle:
        handle.write(_markdown(report))
    return report


def main():
    parser = argparse.ArgumentParser(
        description="运行V3双模型同口径离线POC",
    )
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--families",
        default=",".join(FAMILY_NAMES),
    )
    parser.add_argument("--folds", type=int, default=3)
    parser.add_argument("--estimators", type=int, default=180)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    families = tuple(
        name.strip()
        for name in args.families.split(",")
        if name.strip()
    )
    report = run_bakeoff(
        args.input,
        args.output_dir,
        families=families,
        folds_count=args.folds,
        estimators=args.estimators,
        threads=args.threads,
        seed=args.seed,
    )
    print(json.dumps({
        "ok": True,
        "output": os.path.abspath(args.output_dir),
        "decision": report["decision"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
