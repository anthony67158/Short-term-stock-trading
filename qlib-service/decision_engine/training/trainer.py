"""Train the production-gated opportunity action-value candidate."""

import argparse
import json
import os
import time

import numpy as np

from ..contracts import (
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    SCORE_SCHEMA_VERSION,
)
from .datasets import opportunity_dataset_readiness
from .evaluation import (
    apply_probability_calibrator,
    binary_metrics,
    block_bootstrap_lower_bound,
    fit_probability_calibrator,
    fit_stratified_probability_calibrator,
    ranking_metrics,
    regression_metrics,
    select_risk_adjusted_trial,
    shadow_gate,
)
from time_splits import (
    expanding_date_folds,
    purged_holdout_split,
    three_way_purged_split,
)


MODEL_VERSION_PREFIX = "opportunity-score"
TRAINING_SCHEMA_VERSION = "opportunity-training.v1"
PREDICTION_CONTRACT_VERSION = "opportunity-hurdle-q10.v1"
MODEL_FILENAMES = {
    "pFill": "opportunity_fill_lgb.txt",
    "pWinGivenFill": "opportunity_win_lgb.txt",
    "winPayoffR": "opportunity_win_payoff_lgb.txt",
    "lossPayoffR": "opportunity_loss_payoff_lgb.txt",
    "netRLower10": "opportunity_q10_lgb.txt",
    "ranking": "opportunity_ranker_catboost.json",
}
SHADOW_FEATURE_GROUPS = {
    "orderFlow": (
        "mainRatio",
        "mainNetYi",
        "retailNetYi",
        "flowDivergence",
        "vwapDistancePct",
        "orderImbalanceShort",
        "signalOrderFlowContinuation",
    ),
    "fundContinuity": (
        "main5dYi",
        "retail5dYi",
        "mainInflowDays5",
        "retailInflowDays5",
        "mainStreak5",
        "retailStreak5",
        "mainTrendSlope5",
        "retailTrendSlope5",
        "flowDivergenceBalance5",
    ),
    "dataAvailability": (
        "fundCurrentAvailable",
        "fundHistoryAvailable",
        "fundHistoryDayCount",
        "fundHistoryComplete",
        "dailyTechnicalAvailable",
        "intradayTechnicalAvailable",
        "sectorContextAvailable",
    ),
    "overheat": (
        "intradayRangePct",
        "distanceToHighPct",
        "overheatReversalRisk",
        "signalOverheatRisk",
    ),
    "liquidity": (
        "logAmount",
        "turnover",
        "volumeRatio",
        "liquidityComposite",
        "signalLiquidityConfirmed",
    ),
    "sectorStrength": (
        "sectorRelativeStrength",
        "sectorRankPct",
        "signalSectorRelativeStrength",
    ),
    "limitCrowding": (
        "limitUpDistancePct",
        "limitHitCount5d",
        "failedLimitCount5d",
        "signalLimitCrowding",
    ),
}


def load_decision_dataset(path):
    data = np.load(path, allow_pickle=False)
    required = {
        "X",
        "dates",
        "codes",
        "formula_ids",
        "y_fill",
        "y_win",
        "y_net_r",
        "feature_names",
    }
    optional = {"playbook_ids", "routes"}
    if (
        not required.issubset(set(data.files))
        or not set(data.files).issubset(required | optional)
    ):
        raise ValueError("机会训练数据字段不完整")
    feature_names = tuple(data["feature_names"].astype(str).tolist())
    if feature_names != FEATURE_NAMES:
        raise ValueError("机会训练特征合同不一致")
    X = data["X"].astype(np.float32)
    dates = data["dates"].astype(str)
    codes = data["codes"].astype(str)
    formula_ids = data["formula_ids"].astype(str)
    playbook_ids = (
        data["playbook_ids"].astype(str)
        if "playbook_ids" in data.files
        else np.full(len(X), "UNKNOWN", dtype="<U60")
    )
    routes = (
        data["routes"].astype(str)
        if "routes" in data.files
        else np.full(len(X), "UNKNOWN", dtype="<U30")
    )
    y_fill = data["y_fill"].astype(np.int8)
    y_win = data["y_win"].astype(np.float32)
    y_net_r = data["y_net_r"].astype(np.float32)
    lengths = {
        len(X),
        len(dates),
        len(codes),
        len(formula_ids),
        len(playbook_ids),
        len(routes),
        len(y_fill),
        len(y_win),
        len(y_net_r),
    }
    if (
        X.ndim != 2
        or X.shape[1] != len(FEATURE_NAMES)
        or len(lengths) != 1
        or not np.isfinite(X).all()
    ):
        raise ValueError("机会训练数据维度无效")
    if not set(np.unique(y_fill)).issubset({0, 1}):
        raise ValueError("pFill标签无效")
    return {
        "X": X,
        "dates": dates,
        "codes": codes,
        "formula_ids": formula_ids,
        "playbook_ids": playbook_ids,
        "routes": routes,
        "y_fill": y_fill,
        "y_win": y_win,
        "y_net_r": y_net_r,
    }


def _classifier_probabilities(model, X):
    values = np.asarray(model.predict_proba(X), dtype=np.float64)
    if values.shape != (len(X), 2):
        raise ValueError("分类模型概率维度无效")
    return np.clip(values[:, 1], 1e-8, 1 - 1e-8)


def _fit_lgb_classifier(
    X,
    labels,
    sample_weight=None,
    *,
    random_state=42,
):
    import lightgbm as lgb

    model = lgb.LGBMClassifier(
        objective="binary",
        n_estimators=240,
        learning_rate=0.035,
        num_leaves=15,
        max_depth=5,
        min_child_samples=40,
        subsample=0.85,
        subsample_freq=1,
        colsample_bytree=0.85,
        reg_alpha=0.3,
        reg_lambda=1.0,
        random_state=int(random_state),
        n_jobs=-1,
        verbosity=-1,
    )
    model.fit(
        X,
        labels,
        sample_weight=sample_weight,
        feature_name=list(FEATURE_NAMES),
    )
    return model


def _fit_lgb_regressor(
    X,
    labels,
    sample_weight=None,
    *,
    random_state=42,
):
    import lightgbm as lgb

    model = lgb.LGBMRegressor(
        objective="huber",
        alpha=0.9,
        n_estimators=240,
        learning_rate=0.035,
        num_leaves=15,
        max_depth=5,
        min_child_samples=30,
        subsample=0.85,
        subsample_freq=1,
        colsample_bytree=0.85,
        reg_alpha=0.3,
        reg_lambda=1.0,
        random_state=int(random_state),
        n_jobs=-1,
        verbosity=-1,
    )
    model.fit(
        X,
        labels,
        sample_weight=sample_weight,
        feature_name=list(FEATURE_NAMES),
    )
    return model


def _fit_lgb_quantile_regressor(
    X,
    labels,
    sample_weight=None,
    *,
    random_state=42,
):
    import lightgbm as lgb

    model = lgb.LGBMRegressor(
        objective="quantile",
        alpha=0.1,
        n_estimators=240,
        learning_rate=0.035,
        num_leaves=15,
        max_depth=5,
        min_child_samples=30,
        subsample=0.85,
        subsample_freq=1,
        colsample_bytree=0.85,
        reg_alpha=0.3,
        reg_lambda=1.0,
        random_state=int(random_state),
        n_jobs=-1,
        verbosity=-1,
    )
    model.fit(
        X,
        labels,
        sample_weight=sample_weight,
        feature_name=list(FEATURE_NAMES),
    )
    return model


def _save_booster(model, path):
    booster = getattr(model, "booster_", model)
    if not hasattr(booster, "save_model"):
        raise ValueError("机会模型不支持LightGBM文本导出")
    booster.save_model(path)


def _append_trial(path, value):
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
        ) + "\n")


def _write_report(path, value):
    temporary = path + ".part"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
    os.replace(temporary, path)


def _conditional_indices(indices, *targets):
    selected = np.asarray(indices, dtype=np.int64)
    mask = np.ones(len(selected), dtype=bool)
    for target in targets:
        mask &= np.isfinite(np.asarray(target)[selected])
    return selected[mask]


def _clip_labels(values, low=0.005, high=0.995):
    data = np.asarray(values, dtype=np.float64)
    lower, upper = np.quantile(data, [low, high])
    return np.clip(data, lower, upper), {
        "lower": round(float(lower), 6),
        "upper": round(float(upper), 6),
    }


def _compose_expected_net_r(
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
    if (
        probability.shape != positive.shape
        or negative.shape != positive.shape
    ):
        raise ValueError("机会动作价值数组维度不一致")
    return probability * positive + (1 - probability) * negative


def _constant_regression_metrics(train_labels, holdout_labels):
    prediction = np.full(
        len(holdout_labels),
        float(np.median(train_labels)),
        dtype=np.float64,
    )
    return regression_metrics(holdout_labels, prediction)


def _training_weights(data, indices, labels=None):
    selected = np.asarray(indices, dtype=np.int64)
    weights = np.ones(len(selected), dtype=np.float64)
    dates = data["dates"][selected].astype(str)
    unique_dates = np.unique(dates)
    date_rank = {
        date: rank
        for rank, date in enumerate(unique_dates)
    }
    if len(unique_dates) > 1:
        weights *= np.asarray([
            0.5 + date_rank[date] / (len(unique_dates) - 1)
            for date in dates
        ])
    strata = np.char.add(
        np.char.add(data["playbook_ids"][selected].astype(str), ":"),
        data["routes"][selected].astype(str),
    )
    _, inverse, counts = np.unique(
        strata,
        return_inverse=True,
        return_counts=True,
    )
    weights *= np.sqrt(len(selected) / np.maximum(
        len(counts) * counts[inverse],
        1,
    ))
    if labels is not None:
        binary = np.asarray(labels, dtype=np.int8)
        if binary.shape != (len(selected),):
            raise ValueError("机会训练权重标签维度无效")
        _, class_inverse, class_counts = np.unique(
            binary,
            return_inverse=True,
            return_counts=True,
        )
        weights *= len(selected) / np.maximum(
            len(class_counts) * class_counts[class_inverse],
            1,
        )
        formula_index = FEATURE_NAMES.index("formulaScore")
        formula_strength = np.clip(
            data["X"][selected, formula_index] / 100.0,
            0,
            1,
        )
        weights *= np.where(
            binary == 0,
            1 + 0.75 * formula_strength,
            1.0,
        )
    weights = np.clip(weights, 0.25, 4.0)
    return weights / max(float(weights.mean()), 1e-9)


def _rank_relevance(values):
    actual = np.nan_to_num(
        np.asarray(values, dtype=np.float64),
        nan=0.0,
    )
    positive = actual[actual > 0]
    if not len(positive):
        raise ValueError("排序训练集没有正收益样本")
    middle, high = np.quantile(positive, [0.5, 0.8])
    labels = np.ones(len(actual), dtype=np.int32)
    labels[actual < 0] = 0
    labels[actual > 0] = 2
    labels[actual > middle] = 3
    labels[actual > high] = 4
    return labels, {
        "zeroOrUnfilled": 1,
        "positiveMedian": round(float(middle), 6),
        "positiveHigh": round(float(high), 6),
    }


def _fit_rank_value_calibrator(scores, values):
    x = np.asarray(scores, dtype=np.float64)
    y = np.asarray(values, dtype=np.float64)
    if (
        x.ndim != 1
        or y.shape != x.shape
        or len(x) < 20
        or not np.isfinite(x).all()
        or not np.isfinite(y).all()
    ):
        raise ValueError("排序价值校准样本无效")
    lower, upper = np.quantile(y, [0.01, 0.99])
    order = np.argsort(x, kind="stable")
    ordered_x = x[order]
    ordered_y = np.clip(y[order], lower, upper)
    unique_x, inverse = np.unique(ordered_x, return_inverse=True)
    if len(unique_x) == 1:
        unique_x = np.asarray(
            [unique_x[0] - 1e-9, unique_x[0] + 1e-9],
            dtype=np.float64,
        )
        mean = float(np.mean(ordered_y))
        return {
            "method": "isotonic",
            "score": unique_x.astype(float).tolist(),
            "expectedNetR": [mean, mean],
            "sampleCount": int(len(x)),
            "labelClip": {
                "lower": round(float(lower), 6),
                "upper": round(float(upper), 6),
            },
        }
    sums = np.bincount(inverse, weights=ordered_y).astype(np.float64)
    counts = np.bincount(inverse).astype(np.float64)
    blocks = [
        {
            "start": index,
            "end": index,
            "weight": counts[index],
            "sum": sums[index],
        }
        for index in range(len(unique_x))
    ]
    cursor = 0
    while cursor < len(blocks) - 1:
        left = blocks[cursor]
        right = blocks[cursor + 1]
        left_mean = left["sum"] / left["weight"]
        right_mean = right["sum"] / right["weight"]
        if left_mean <= right_mean:
            cursor += 1
            continue
        blocks[cursor:cursor + 2] = [{
            "start": left["start"],
            "end": right["end"],
            "weight": left["weight"] + right["weight"],
            "sum": left["sum"] + right["sum"],
        }]
        cursor = max(0, cursor - 1)
    fitted = np.empty(len(unique_x), dtype=np.float64)
    for block in blocks:
        fitted[block["start"]:block["end"] + 1] = (
            block["sum"] / block["weight"]
        )
    return {
        "method": "isotonic",
        "score": unique_x.astype(float).tolist(),
        "expectedNetR": fitted.astype(float).tolist(),
        "sampleCount": int(len(x)),
        "labelClip": {
            "lower": round(float(lower), 6),
            "upper": round(float(upper), 6),
        },
    }


def _apply_rank_value_calibrator(scores, artifact):
    x = np.asarray((artifact or {}).get("score"), dtype=np.float64)
    y = np.asarray(
        (artifact or {}).get("expectedNetR"),
        dtype=np.float64,
    )
    values = np.asarray(scores, dtype=np.float64)
    if (
        x.ndim != 1
        or y.shape != x.shape
        or len(x) < 2
        or not np.isfinite(x).all()
        or not np.isfinite(y).all()
        or np.any(np.diff(x) < 0)
    ):
        raise ValueError("排序价值校准参数无效")
    return np.interp(values, x, y)


def _fit_catboost_ranker(data, train_index, *, random_state=42):
    from catboost import CatBoostRanker

    selected = np.asarray(train_index, dtype=np.int64)
    dates = data["dates"][selected].astype(str)
    codes = data["codes"][selected].astype(str)
    order = np.lexsort((codes, dates))
    sorted_index = selected[order]
    sorted_dates = dates[order]
    _, group_ids = np.unique(sorted_dates, return_inverse=True)
    relevance, thresholds = _rank_relevance(
        data["y_net_r"][sorted_index],
    )
    model = CatBoostRanker(
        loss_function="YetiRankPairwise",
        iterations=240,
        learning_rate=0.04,
        depth=6,
        random_seed=int(random_state),
        thread_count=-1,
        verbose=False,
        allow_writing_files=False,
    )
    model.fit(
        data["X"][sorted_index],
        relevance,
        group_id=group_ids.astype(np.int32),
    )
    return model, thresholds


def _ranker_report(
    data,
    train_index,
    calibration_index,
    holdout_index,
):
    model, thresholds = _fit_catboost_ranker(data, train_index)
    calibration_scores = np.asarray(
        model.predict(data["X"][calibration_index]),
        dtype=np.float64,
    )
    holdout_scores = np.asarray(
        model.predict(data["X"][holdout_index]),
        dtype=np.float64,
    )
    if (
        not np.isfinite(calibration_scores).all()
        or not np.isfinite(holdout_scores).all()
    ):
        raise ValueError("CatBoost排序分包含非有限值")
    filled_calibration = calibration_index[
        np.isfinite(data["y_net_r"][calibration_index])
    ]
    if len(filled_calibration) < 20:
        raise ValueError("CatBoost排序价值校准样本不足")
    calibration_filled_scores = np.asarray(
        model.predict(data["X"][filled_calibration]),
        dtype=np.float64,
    )
    value_calibration = _fit_rank_value_calibrator(
        calibration_filled_scores,
        data["y_net_r"][filled_calibration],
    )
    score_quantiles = np.quantile(
        calibration_scores,
        np.linspace(0.0, 1.0, 101),
    )
    actual = np.nan_to_num(
        data["y_net_r"][holdout_index],
        nan=0.0,
    )
    ranking = ranking_metrics(
        actual > 0,
        actual,
        holdout_scores,
        data["dates"][holdout_index],
        top_k=5,
        group_ids=data["codes"][holdout_index],
    )
    return {
        "model": model,
        "scores": holdout_scores,
        "expected_net_r": _apply_rank_value_calibrator(
            holdout_scores,
            value_calibration,
        ),
        "ranking": {
            **ranking,
            "netRLowerBound": block_bootstrap_lower_bound(
                ranking["daily_net_r"],
                samples=2000,
                random_state=42,
            ),
        },
        "calibration": {
            "method": "empirical-cdf",
            "sampleCount": int(len(calibration_scores)),
            "scoreQuantiles": score_quantiles.astype(float).tolist(),
        },
        "valueCalibration": value_calibration,
        "relevance": thresholds,
    }


def _apply_win_calibration(data, indices, probabilities, artifact):
    selected = np.asarray(indices, dtype=np.int64)
    return apply_probability_calibrator(
        probabilities,
        artifact,
        playbook_ids=data["playbook_ids"][selected],
        routes=data["routes"][selected],
    )


def _predict_action_value(
    data,
    indices,
    win_report,
    action_value_report,
    *,
    X=None,
):
    selected = np.asarray(indices, dtype=np.int64)
    matrix = data["X"][selected] if X is None else X
    win_probability = apply_probability_calibrator(
        _classifier_probabilities(win_report["model"], matrix),
        win_report["calibration"],
        playbook_ids=data["playbook_ids"][selected],
        routes=data["routes"][selected],
    )
    return _compose_expected_net_r(
        win_probability,
        action_value_report["models"]["winPayoffR"].predict(matrix),
        action_value_report["models"]["lossPayoffR"].predict(matrix),
    )


def _select_rank_blend_weight(
    data,
    calibration_index,
    win_report,
    action_value_report,
    ranker_report,
):
    action_value = _predict_action_value(
        data,
        calibration_index,
        win_report,
        action_value_report,
    )
    ranker_scores = np.asarray(
        ranker_report["model"].predict(
            data["X"][calibration_index]
        ),
        dtype=np.float64,
    )
    rank_value = _apply_rank_value_calibrator(
        ranker_scores,
        ranker_report["valueCalibration"],
    )
    actual = np.nan_to_num(
        data["y_net_r"][calibration_index],
        nan=0.0,
    )
    candidates = []
    for weight in (0.0, 0.25, 0.5, 0.75, 1.0):
        expected = (
            (1 - weight) * action_value
            + weight * rank_value
        )
        coverage = float(np.mean(expected > 0))
        metrics = ranking_metrics(
            actual > 0,
            actual,
            ranker_scores,
            data["dates"][calibration_index],
            top_k=5,
            group_ids=data["codes"][calibration_index],
            eligible_mask=expected > 0,
        )
        candidates.append({
            "weight": weight,
            "meanNetRAt5": metrics["mean_net_r_at_5"],
            "netRLowerBound": block_bootstrap_lower_bound(
                metrics["daily_net_r"],
                samples=2000,
                random_state=42,
            ),
            "maxDrawdownRAt5":
                metrics["max_drawdown_r_at_5"],
            "positiveExpectedCoverage": round(coverage, 6),
        })
    selected = select_risk_adjusted_trial(
        candidates,
        minimum_coverage=0.02,
    )
    return selected["weight"], candidates


def _blend_expected_net_r(action_value, rank_value, weight):
    normalized = max(0.0, min(1.0, float(weight)))
    return (
        (1 - normalized) * np.asarray(action_value, dtype=np.float64)
        + normalized * np.asarray(rank_value, dtype=np.float64)
    )


def _classification_report(
    data,
    X,
    labels,
    train_index,
    calibration_index,
    holdout_index,
    *,
    stratified=False,
):
    challenger = _fit_lgb_classifier(
        X[train_index],
        labels[train_index],
        sample_weight=_training_weights(
            data,
            train_index,
            labels[train_index],
        ),
    )
    challenger_calibration_prob = _classifier_probabilities(
        challenger,
        X[calibration_index],
    )
    if stratified:
        challenger_calibration = (
            fit_stratified_probability_calibrator(
                labels[calibration_index],
                challenger_calibration_prob,
                data["playbook_ids"][calibration_index],
                data["routes"][calibration_index],
                dates=data["dates"][calibration_index],
            )
        )
        challenger_holdout_prob = _apply_win_calibration(
            data,
            holdout_index,
            _classifier_probabilities(challenger, X[holdout_index]),
            challenger_calibration,
        )
    else:
        challenger_calibration = fit_probability_calibrator(
            labels[calibration_index],
            challenger_calibration_prob,
        )
        challenger_holdout_prob = apply_probability_calibrator(
            _classifier_probabilities(challenger, X[holdout_index]),
            challenger_calibration,
        )
    constant_probability = np.full(
        len(holdout_index),
        np.clip(
            float(np.mean(labels[train_index])),
            1e-8,
            1 - 1e-8,
        ),
        dtype=np.float64,
    )
    challenger_metrics = binary_metrics(
        labels[holdout_index],
        challenger_holdout_prob,
    )
    constant_metrics = binary_metrics(
        labels[holdout_index],
        constant_probability,
    )
    return {
        "model": challenger,
        "calibration": challenger_calibration,
        "challenger_probabilities": challenger_holdout_prob,
        "challenger": challenger_metrics,
        "baseline": constant_metrics,
        "constantBaseline": constant_metrics,
        "brierSkill": round(
            1 - challenger_metrics["brier"] / constant_metrics["brier"],
            6,
        ),
        "calibration_samples": int(len(calibration_index)),
    }


def _action_value_report(
    data,
    X,
    labels,
    train_index,
    calibration_index,
    holdout_index,
    win_report,
):
    positive_train = train_index[labels[train_index] > 0]
    negative_train = train_index[labels[train_index] <= 0]
    if not len(positive_train) or not len(negative_train):
        raise ValueError("胜负幅度训练样本不完整")
    positive_labels, positive_clip = _clip_labels(
        labels[positive_train],
    )
    negative_labels, negative_clip = _clip_labels(
        labels[negative_train],
    )
    quantile_labels, quantile_clip = _clip_labels(
        labels[train_index],
    )
    win_payoff = _fit_lgb_regressor(
        X[positive_train],
        positive_labels,
        sample_weight=_training_weights(data, positive_train),
    )
    loss_payoff = _fit_lgb_regressor(
        X[negative_train],
        negative_labels,
        sample_weight=_training_weights(data, negative_train),
    )
    quantile = _fit_lgb_quantile_regressor(
        X[train_index],
        quantile_labels,
        sample_weight=_training_weights(data, train_index),
    )
    win_probability = _apply_win_calibration(
        data,
        holdout_index,
        _classifier_probabilities(
            win_report["model"],
            X[holdout_index],
        ),
        win_report["calibration"],
    )
    expected_net_r = _compose_expected_net_r(
        win_probability,
        win_payoff.predict(X[holdout_index]),
        loss_payoff.predict(X[holdout_index]),
    )
    raw_calibration_q10 = np.asarray(
        quantile.predict(X[calibration_index]),
        dtype=np.float64,
    )
    q10_offset = float(np.quantile(
        labels[calibration_index] - raw_calibration_q10,
        0.1,
    ))
    q10_prediction = np.minimum(
        np.asarray(
            quantile.predict(X[holdout_index]),
            dtype=np.float64,
        ) + q10_offset,
        expected_net_r,
    )
    actual = np.asarray(labels[holdout_index], dtype=np.float64)
    challenger_metrics = regression_metrics(
        actual,
        expected_net_r,
    )
    baseline_metrics = _constant_regression_metrics(
        labels[train_index],
        actual,
    )
    return {
        "models": {
            "winPayoffR": win_payoff,
            "lossPayoffR": loss_payoff,
            "netRLower10": quantile,
        },
        "expected_net_r": expected_net_r,
        "q10_prediction": q10_prediction,
        "q10_offset": q10_offset,
        "challenger": challenger_metrics,
        "baseline": baseline_metrics,
        "mae_skill": round(
            1 - challenger_metrics["mae"] / baseline_metrics["mae"],
            6,
        ),
        "quantile10": {
            "coverage": round(float(np.mean(actual >= q10_prediction)), 6),
            "crossingRate": round(float(np.mean(
                q10_prediction > expected_net_r
            )), 6),
        },
        "labelClip": {
            "winPayoff": positive_clip,
            "lossPayoff": negative_clip,
            "quantile10": quantile_clip,
        },
    }


def _not_ready_report(now, readiness, split=None):
    return {
        "schemaVersion": TRAINING_SCHEMA_VERSION,
        "state": "NOT_READY",
        "generatedAt": int(now),
        "modelVersion": None,
        "shadowEligible": False,
        "shadowBlockers": list(readiness["blockers"]),
        "productionEligible": False,
        "productionBlockers": [
            "机会雷达真实成熟样本不足",
        ],
        "readiness": readiness,
        "split": split,
        "metrics": {},
    }


def _feature_group_ablation(
    data,
    holdout_index,
    dates,
    codes,
    actual_net_r,
    fill_report,
    win_report,
    action_value_report,
):
    output = {}
    X = data["X"]
    for group, names in SHADOW_FEATURE_GROUPS.items():
        indexes = [
            FEATURE_NAMES.index(name)
            for name in names
            if name in FEATURE_NAMES
        ]
        if not indexes:
            continue
        reduced = np.array(X[holdout_index], copy=True)
        reduced[:, indexes] = 0.0
        fill_probability = apply_probability_calibrator(
            _classifier_probabilities(
                fill_report["model"],
                reduced,
            ),
            fill_report["calibration"],
        )
        win_probability = _apply_win_calibration(
            data,
            holdout_index,
            _classifier_probabilities(
                win_report["model"],
                reduced,
            ),
            win_report["calibration"],
        )
        predicted_net_r = _compose_expected_net_r(
            win_probability,
            action_value_report["models"]["winPayoffR"].predict(
                reduced
            ),
            action_value_report["models"]["lossPayoffR"].predict(
                reduced
            ),
        )
        output[group] = ranking_metrics(
            actual_net_r > 0,
            actual_net_r,
            fill_probability * predicted_net_r,
            dates[holdout_index],
            top_k=5,
            group_ids=codes[holdout_index],
        )
        output[group].pop("daily_net_r", None)
    return output


def _walk_forward_report(data, *, n_splits=3, purge_dates=5):
    folds = expanding_date_folds(
        data["dates"],
        n_splits=n_splits,
        purge_dates=purge_dates,
    )
    reports = []
    for fold_number, (outer_train, validation) in enumerate(folds, 1):
        try:
            inner_train_relative, calibration_relative, inner_meta = (
                purged_holdout_split(
                    data["dates"][outer_train],
                    holdout_fraction=0.2,
                    purge_dates=purge_dates,
                )
            )
            train_index = outer_train[inner_train_relative]
            calibration_index = outer_train[calibration_relative]
            win_train = _conditional_indices(
                train_index,
                data["y_win"],
                data["y_net_r"],
            )
            win_calibration = _conditional_indices(
                calibration_index,
                data["y_win"],
                data["y_net_r"],
            )
            win_validation = _conditional_indices(
                validation,
                data["y_win"],
                data["y_net_r"],
            )
            for indices, labels in (
                (train_index, data["y_fill"]),
                (calibration_index, data["y_fill"]),
                (validation, data["y_fill"]),
                (win_train, data["y_win"]),
                (win_calibration, data["y_win"]),
                (win_validation, data["y_win"]),
            ):
                if (
                    not len(indices)
                    or len(set(
                        np.asarray(labels)[indices]
                        .astype(int)
                        .tolist()
                    )) < 2
                ):
                    raise ValueError("fold二分类标签不完整")
            fill = _classification_report(
                data,
                data["X"],
                data["y_fill"],
                train_index,
                calibration_index,
                validation,
            )
            win_labels = np.nan_to_num(
                data["y_win"],
                nan=0.0,
            ).astype(np.int8)
            win = _classification_report(
                data,
                data["X"],
                win_labels,
                win_train,
                win_calibration,
                win_validation,
                stratified=True,
            )
            action_value = _action_value_report(
                data,
                data["X"],
                data["y_net_r"],
                win_train,
                win_calibration,
                win_validation,
                win,
            )
            ranker = _ranker_report(
                data,
                train_index,
                calibration_index,
                validation,
            )
            blend_weight, blend_trials = _select_rank_blend_weight(
                data,
                calibration_index,
                win,
                action_value,
                ranker,
            )
            validation_action_value = _predict_action_value(
                data,
                validation,
                win,
                action_value,
            )
            validation_net_r = _blend_expected_net_r(
                validation_action_value,
                ranker["expected_net_r"],
                blend_weight,
            )
            actual_net_r = np.nan_to_num(
                data["y_net_r"][validation],
                nan=0.0,
            )
            action_ranking = ranking_metrics(
                actual_net_r > 0,
                actual_net_r,
                fill["challenger_probabilities"]
                * validation_action_value,
                data["dates"][validation],
                top_k=5,
                group_ids=data["codes"][validation],
                eligible_mask=validation_action_value > 0,
            )
            combination_ranking = ranking_metrics(
                actual_net_r > 0,
                actual_net_r,
                ranker["scores"],
                data["dates"][validation],
                top_k=5,
                group_ids=data["codes"][validation],
                eligible_mask=validation_net_r > 0,
            )
            filled_mask = np.isfinite(data["y_net_r"][validation])
            actual_filled = data["y_net_r"][validation][filled_mask]
            predicted_filled = validation_net_r[filled_mask]
            value_metrics = regression_metrics(
                actual_filled,
                predicted_filled,
            )
            value_baseline = _constant_regression_metrics(
                data["y_net_r"][win_train],
                actual_filled,
            )
            formula_score_index = FEATURE_NAMES.index("formulaScore")
            ranking_baseline = ranking_metrics(
                actual_net_r > 0,
                actual_net_r,
                data["X"][validation, formula_score_index],
                data["dates"][validation],
                top_k=5,
                group_ids=data["codes"][validation],
            )
            fold_metrics = {
                "pFill": {
                    "challenger": fill["challenger"],
                    "baseline": fill["baseline"],
                    "constantBaseline": fill["constantBaseline"],
                    "brierSkill": fill["brierSkill"],
                },
                "pWinGivenFill": {
                    "challenger": win["challenger"],
                    "baseline": win["baseline"],
                    "constantBaseline": win["constantBaseline"],
                    "brierSkill": win["brierSkill"],
                },
                "expectedNetR": {
                    "challenger": value_metrics,
                    "baseline": value_baseline,
                    "maeSkill": round(
                        1 - value_metrics["mae"]
                        / value_baseline["mae"],
                        6,
                    ),
                    "rankBlendWeight": blend_weight,
                    "blendTrials": blend_trials,
                },
                "quantile10": action_value["quantile10"],
                "ranking": {
                    "challenger": {
                        **combination_ranking,
                        "netRLowerBound": block_bootstrap_lower_bound(
                            combination_ranking["daily_net_r"],
                            samples=2000,
                            random_state=42,
                        ),
                    },
                    "actionValue": {
                        **action_ranking,
                        "netRLowerBound": block_bootstrap_lower_bound(
                            action_ranking["daily_net_r"],
                            samples=2000,
                            random_state=42,
                        ),
                    },
                    "baseline": ranking_baseline,
                    "ranker": ranker["ranking"],
                },
            }
            gate = shadow_gate(fold_metrics)
            reports.append({
                "fold": fold_number,
                "trainEndDate": inner_meta["train_samples"]
                and str(data["dates"][train_index][-1]),
                "validationStartDate": str(
                    data["dates"][validation][0]
                ),
                "validationEndDate": str(
                    data["dates"][validation][-1]
                ),
                "trainSamples": int(len(train_index)),
                "calibrationSamples": int(len(calibration_index)),
                "validationSamples": int(len(validation)),
                "shadowEligible": gate["shadowEligible"],
                "blockers": gate["shadowBlockers"],
                "metrics": fold_metrics,
            })
        except ValueError:
            continue
    return {
        "folds": len(reports),
        "requiredFolds": 2,
        "shadowEligible": (
            len(reports) >= 2
            and all(item["shadowEligible"] for item in reports)
        ),
        "results": reports,
    }


def train_decision_model(
    dataset_path,
    output_directory,
    *,
    now=None,
    minimum_samples=1000,
    minimum_filled_samples=300,
    minimum_dates=60,
):
    timestamp = int(now if now is not None else time.time())
    os.makedirs(output_directory, exist_ok=True)
    trial_path = os.path.join(
        output_directory,
        "opportunity_trials.jsonl",
    )
    report_path = os.path.join(
        output_directory,
        "opportunity_training_report.json",
    )
    data = load_decision_dataset(dataset_path)
    readiness = opportunity_dataset_readiness(
        data,
        minimum_samples=minimum_samples,
        minimum_filled_samples=minimum_filled_samples,
        minimum_dates=minimum_dates,
    )
    if not readiness["ready"]:
        report = _not_ready_report(timestamp, readiness)
        _append_trial(trial_path, report)
        _write_report(report_path, report)
        return report

    walk_forward = _walk_forward_report(data)
    try:
        train_index, calibration_index, holdout_index, split = (
            three_way_purged_split(
                data["dates"],
                calibration_fraction=0.15,
                holdout_fraction=0.15,
                purge_dates=5,
            )
        )
        win_train = _conditional_indices(
            train_index,
            data["y_win"],
            data["y_net_r"],
        )
        win_calibration = _conditional_indices(
            calibration_index,
            data["y_win"],
            data["y_net_r"],
        )
        win_holdout = _conditional_indices(
            holdout_index,
            data["y_win"],
            data["y_net_r"],
        )
        if not all(map(len, (
            win_train,
            win_calibration,
            win_holdout,
        ))):
            raise ValueError("成交后条件样本在时间切分中为空")
        for indices, label in (
            (train_index, data["y_fill"]),
            (calibration_index, data["y_fill"]),
            (holdout_index, data["y_fill"]),
            (win_train, data["y_win"]),
            (win_calibration, data["y_win"]),
            (win_holdout, data["y_win"]),
        ):
            if len(set(np.asarray(label)[indices].astype(int).tolist())) < 2:
                raise ValueError("时间切分后的二分类标签缺少正负两类")
    except ValueError as error:
        readiness = {
            **readiness,
            "ready": False,
            "blockers": [*readiness["blockers"], str(error)],
        }
        report = _not_ready_report(timestamp, readiness)
        _append_trial(trial_path, report)
        _write_report(report_path, report)
        return report

    fill = _classification_report(
        data,
        data["X"],
        data["y_fill"],
        train_index,
        calibration_index,
        holdout_index,
    )
    win_labels = np.nan_to_num(
        data["y_win"],
        nan=0.0,
    ).astype(np.int8)
    win = _classification_report(
        data,
        data["X"],
        win_labels,
        win_train,
        win_calibration,
        win_holdout,
        stratified=True,
    )
    action_value = _action_value_report(
        data,
        data["X"],
        data["y_net_r"],
        win_train,
        win_calibration,
        win_holdout,
        win,
    )
    ranker = _ranker_report(
        data,
        train_index,
        calibration_index,
        holdout_index,
    )
    blend_weight, blend_trials = _select_rank_blend_weight(
        data,
        calibration_index,
        win,
        action_value,
        ranker,
    )
    holdout_action_value = _predict_action_value(
        data,
        holdout_index,
        win,
        action_value,
    )
    holdout_net_r_all = _blend_expected_net_r(
        holdout_action_value,
        ranker["expected_net_r"],
        blend_weight,
    )
    filled_holdout_mask = np.isfinite(data["y_net_r"][holdout_index])
    actual_filled = data["y_net_r"][holdout_index][filled_holdout_mask]
    predicted_filled = holdout_net_r_all[filled_holdout_mask]
    value_metrics = regression_metrics(
        actual_filled,
        predicted_filled,
    )
    value_baseline = _constant_regression_metrics(
        data["y_net_r"][win_train],
        actual_filled,
    )
    metrics = {
        "pFill": {
            "challenger": fill["challenger"],
            "baseline": fill["baseline"],
            "constantBaseline": fill["constantBaseline"],
            "brierSkill": fill["brierSkill"],
        },
        "pWinGivenFill": {
            "challenger": win["challenger"],
            "baseline": win["baseline"],
            "constantBaseline": win["constantBaseline"],
            "brierSkill": win["brierSkill"],
        },
        "expectedNetR": {
            "challenger": value_metrics,
            "baseline": value_baseline,
            "maeSkill": round(
                1 - value_metrics["mae"] / value_baseline["mae"],
                6,
            ),
            "rankBlendWeight": blend_weight,
            "blendTrials": blend_trials,
        },
        "quantile10": action_value["quantile10"],
        "coverage": {
            "positiveExpected": round(float(np.mean(
                holdout_net_r_all > 0
            )), 6),
            "positiveQ10": round(float(np.mean(
                action_value["q10_prediction"] > 0
            )), 6),
        },
    }
    holdout_fill = fill["challenger_probabilities"]
    utility = holdout_fill * holdout_net_r_all
    actual_net_r = np.nan_to_num(
        data["y_net_r"][holdout_index],
        nan=0.0,
    )
    challenger_ranking = ranking_metrics(
        actual_net_r > 0,
        actual_net_r,
        utility,
        data["dates"][holdout_index],
        top_k=5,
        group_ids=data["codes"][holdout_index],
        eligible_mask=holdout_net_r_all > 0,
    )
    challenger_top3 = ranking_metrics(
        actual_net_r > 0,
        actual_net_r,
        utility,
        data["dates"][holdout_index],
        top_k=3,
        group_ids=data["codes"][holdout_index],
    )
    challenger_ranking.update({
        key: value
        for key, value in challenger_top3.items()
        if key != "daily_net_r"
    })
    formula_score_index = FEATURE_NAMES.index("formulaScore")
    baseline_ranking = ranking_metrics(
        actual_net_r > 0,
        actual_net_r,
        data["X"][holdout_index, formula_score_index],
        data["dates"][holdout_index],
        top_k=5,
        group_ids=data["codes"][holdout_index],
    )
    baseline_top3 = ranking_metrics(
        actual_net_r > 0,
        actual_net_r,
        data["X"][holdout_index, formula_score_index],
        data["dates"][holdout_index],
        top_k=3,
        group_ids=data["codes"][holdout_index],
    )
    baseline_ranking.update({
        key: value
        for key, value in baseline_top3.items()
        if key != "daily_net_r"
    })
    lower_bound = block_bootstrap_lower_bound(
        challenger_ranking["daily_net_r"],
        samples=2000,
        random_state=42,
    )
    combined_ranking = ranking_metrics(
        actual_net_r > 0,
        actual_net_r,
        ranker["scores"],
        data["dates"][holdout_index],
        top_k=5,
        group_ids=data["codes"][holdout_index],
        eligible_mask=holdout_net_r_all > 0,
    )
    combined_top3 = ranking_metrics(
        actual_net_r > 0,
        actual_net_r,
        ranker["scores"],
        data["dates"][holdout_index],
        top_k=3,
        group_ids=data["codes"][holdout_index],
        eligible_mask=holdout_net_r_all > 0,
    )
    combined_ranking.update({
        key: value
        for key, value in combined_top3.items()
        if key != "daily_net_r"
    })
    metrics["ranking"] = {
        "challenger": {
            **combined_ranking,
            "netRLowerBound": block_bootstrap_lower_bound(
                combined_ranking["daily_net_r"],
                samples=2000,
                random_state=42,
            ),
        },
        "actionValue": {
            **challenger_ranking,
            "netRLowerBound": lower_bound,
        },
        "baseline": baseline_ranking,
        "ranker": ranker["ranking"],
    }
    metrics["featureAblation"] = _feature_group_ablation(
        data,
        holdout_index,
        data["dates"],
        data["codes"],
        actual_net_r,
        fill,
        win,
        action_value,
    )
    gate = shadow_gate(metrics)
    if not walk_forward["shadowEligible"]:
        gate["shadowEligible"] = False
        gate["shadowBlockers"].append(
            "walk-forward时间窗未稳定优于简单基线"
        )
    model_version = (
        f"{MODEL_VERSION_PREFIX}."
        + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(timestamp))
    )
    report = {
        "schemaVersion": TRAINING_SCHEMA_VERSION,
        "state": (
            "SHADOW_READY"
            if gate["shadowEligible"]
            else "REJECTED"
        ),
        "generatedAt": timestamp,
        "modelVersion": model_version,
        "shadowEligible": gate["shadowEligible"],
        "shadowBlockers": gate["shadowBlockers"],
        "productionEligible": False,
        "productionBlockers": gate["productionBlockers"],
        "readiness": readiness,
        "split": split,
        "walkForward": walk_forward,
        "metrics": metrics,
    }
    _append_trial(trial_path, report)
    _write_report(report_path, report)
    development_index = np.sort(np.concatenate([
        train_index,
        calibration_index,
    ]))
    development_win = _conditional_indices(
        development_index,
        data["y_win"],
        data["y_net_r"],
    )
    final_fill = _classification_report(
        data,
        data["X"],
        data["y_fill"],
        development_index,
        holdout_index,
        holdout_index,
    )
    final_win = _classification_report(
        data,
        data["X"],
        win_labels,
        development_win,
        win_holdout,
        win_holdout,
        stratified=True,
    )
    final_action_value = _action_value_report(
        data,
        data["X"],
        data["y_net_r"],
        development_win,
        win_holdout,
        win_holdout,
        final_win,
    )
    final_ranker = _ranker_report(
        data,
        development_index,
        holdout_index,
        holdout_index,
    )
    final_blend_weight, final_blend_trials = (
        _select_rank_blend_weight(
            data,
            holdout_index,
            final_win,
            final_action_value,
            final_ranker,
        )
    )
    # The latest holdout remains the final calibration window. The tree heads
    # train on all earlier samples after the independent POC has been recorded.
    shadow = os.path.join(output_directory, "shadow")
    os.makedirs(shadow, exist_ok=True)
    _save_booster(final_fill["model"], os.path.join(
        shadow,
        MODEL_FILENAMES["pFill"],
    ))
    _save_booster(final_win["model"], os.path.join(
        shadow,
        MODEL_FILENAMES["pWinGivenFill"],
    ))
    for slot, model in final_action_value["models"].items():
        _save_booster(model, os.path.join(
            shadow,
            MODEL_FILENAMES[slot],
        ))
    final_ranker["model"].save_model(
        os.path.join(shadow, MODEL_FILENAMES["ranking"]),
        format="json",
    )
    sorted_train_net_r = np.sort(data["y_net_r"][development_win])
    tail_count = max(1, int(np.ceil(len(sorted_train_net_r) * 0.1)))
    meta = {
        "schemaVersion": SCORE_SCHEMA_VERSION,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "modelVersion": model_version,
        "trainedAt": timestamp,
        "featureNames": list(FEATURE_NAMES),
        "predictionContract": PREDICTION_CONTRACT_VERSION,
        "modelHeads": list(MODEL_FILENAMES),
        "shadowOnly": True,
        "shadowEligible": gate["shadowEligible"],
        "productionEligible": False,
        "usagePolicy": "DIRECT",
        "split": split,
        "metrics": metrics,
        "calibration": {
            "pFill": final_fill["calibration"],
            "pWinGivenFill": final_win["calibration"],
            "pFillSampleCount": int(len(holdout_index)),
            "pWinGivenFillSampleCount": int(len(win_holdout)),
        },
        "rankingCalibration": final_ranker["calibration"],
        "rankValueCalibration": final_ranker["valueCalibration"],
        "rankBlendWeight": final_blend_weight,
        "rankBlendTrials": final_blend_trials,
        "rankingRelevance": final_ranker["relevance"],
        "risk": {
            "q10CalibrationOffset": round(
                float(final_action_value["q10_offset"]),
                6,
            ),
            "q10Coverage":
                final_action_value["quantile10"]["coverage"],
            "expectedShortfall10": round(
                float(sorted_train_net_r[:tail_count].mean()),
                6,
            ),
        },
        "labelClip": action_value["labelClip"],
        "ood": {
            "minimum": np.percentile(
                data["X"][development_index],
                0.5,
                axis=0,
            ).astype(float).tolist(),
            "maximum": np.percentile(
                data["X"][development_index],
                99.5,
                axis=0,
            ).astype(float).tolist(),
            "maximumViolationFraction": 0.1,
        },
    }
    _write_report(
        os.path.join(shadow, "opportunity_meta.json"),
        meta,
    )
    return report


def main():
    parser = argparse.ArgumentParser(
        description="训练机会雷达动作价值候选模型",
    )
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    report = train_decision_model(args.dataset, args.output)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
