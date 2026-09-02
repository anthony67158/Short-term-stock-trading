"""Train the independent, shadow-only opportunity ranking sidecar."""

import argparse
import json
import os
import time

import numpy as np

from opportunity_contract import (
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    SCORE_SCHEMA_VERSION,
)
from opportunity_dataset import opportunity_dataset_readiness
from opportunity_evaluation import (
    apply_probability_calibrator,
    binary_metrics,
    block_bootstrap_lower_bound,
    fit_probability_calibrator,
    ranking_metrics,
    regression_metrics,
    shadow_gate,
)
from time_splits import (
    expanding_date_folds,
    purged_holdout_split,
    three_way_purged_split,
)


MODEL_VERSION_PREFIX = "opportunity-score"
TRAINING_SCHEMA_VERSION = "opportunity-training.v1"
MODEL_FILENAMES = {
    "pFill": "opportunity_fill_lgb.txt",
    "pWinGivenFill": "opportunity_win_lgb.txt",
    "expectedNetR": "opportunity_netr_lgb.txt",
}


def load_opportunity_dataset(path):
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
    if set(data.files) != required:
        raise ValueError("机会训练数据字段不完整")
    feature_names = tuple(data["feature_names"].astype(str).tolist())
    if feature_names != FEATURE_NAMES:
        raise ValueError("机会训练特征合同不一致")
    X = data["X"].astype(np.float32)
    dates = data["dates"].astype(str)
    codes = data["codes"].astype(str)
    formula_ids = data["formula_ids"].astype(str)
    y_fill = data["y_fill"].astype(np.int8)
    y_win = data["y_win"].astype(np.float32)
    y_net_r = data["y_net_r"].astype(np.float32)
    lengths = {
        len(X),
        len(dates),
        len(codes),
        len(formula_ids),
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
        "y_fill": y_fill,
        "y_win": y_win,
        "y_net_r": y_net_r,
    }


def _classifier_probabilities(model, X):
    values = np.asarray(model.predict_proba(X), dtype=np.float64)
    if values.shape != (len(X), 2):
        raise ValueError("分类模型概率维度无效")
    return np.clip(values[:, 1], 1e-8, 1 - 1e-8)


def _fit_lgb_classifier(X, labels):
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
        random_state=42,
        n_jobs=-1,
        verbosity=-1,
    )
    model.fit(X, labels, feature_name=list(FEATURE_NAMES))
    return model


def _fit_logistic_classifier(X, labels):
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    model = make_pipeline(
        StandardScaler(),
        LogisticRegression(
            C=0.5,
            max_iter=2000,
            random_state=42,
        ),
    )
    model.fit(X, labels)
    return model


def _fit_lgb_regressor(X, labels):
    import lightgbm as lgb

    model = lgb.LGBMRegressor(
        objective="regression",
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
        random_state=42,
        n_jobs=-1,
        verbosity=-1,
    )
    model.fit(X, labels, feature_name=list(FEATURE_NAMES))
    return model


def _fit_linear_regressor(X, labels):
    from sklearn.linear_model import Ridge
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    model = make_pipeline(
        StandardScaler(),
        Ridge(alpha=10.0),
    )
    model.fit(X, labels)
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


def _classification_report(
    X,
    labels,
    train_index,
    calibration_index,
    holdout_index,
):
    challenger = _fit_lgb_classifier(
        X[train_index],
        labels[train_index],
    )
    baseline = _fit_logistic_classifier(
        X[train_index],
        labels[train_index],
    )
    challenger_calibration_prob = _classifier_probabilities(
        challenger,
        X[calibration_index],
    )
    baseline_calibration_prob = _classifier_probabilities(
        baseline,
        X[calibration_index],
    )
    challenger_calibration = fit_probability_calibrator(
        labels[calibration_index],
        challenger_calibration_prob,
    )
    baseline_calibration = fit_probability_calibrator(
        labels[calibration_index],
        baseline_calibration_prob,
    )
    challenger_holdout_prob = apply_probability_calibrator(
        _classifier_probabilities(challenger, X[holdout_index]),
        challenger_calibration,
    )
    baseline_holdout_prob = apply_probability_calibrator(
        _classifier_probabilities(baseline, X[holdout_index]),
        baseline_calibration,
    )
    return {
        "model": challenger,
        "calibration": challenger_calibration,
        "challenger_probabilities": challenger_holdout_prob,
        "baseline_probabilities": baseline_holdout_prob,
        "challenger": binary_metrics(
            labels[holdout_index],
            challenger_holdout_prob,
        ),
        "baseline": binary_metrics(
            labels[holdout_index],
            baseline_holdout_prob,
        ),
        "calibration_samples": int(len(calibration_index)),
    }


def _regression_report(
    X,
    labels,
    train_index,
    holdout_index,
):
    challenger = _fit_lgb_regressor(
        X[train_index],
        labels[train_index],
    )
    baseline = _fit_linear_regressor(
        X[train_index],
        labels[train_index],
    )
    challenger_prediction = np.asarray(
        challenger.predict(X[holdout_index]),
        dtype=np.float64,
    )
    baseline_prediction = np.asarray(
        baseline.predict(X[holdout_index]),
        dtype=np.float64,
    )
    return {
        "model": challenger,
        "challenger_predictions": challenger_prediction,
        "baseline_predictions": baseline_prediction,
        "challenger": regression_metrics(
            labels[holdout_index],
            challenger_prediction,
        ),
        "baseline": regression_metrics(
            labels[holdout_index],
            baseline_prediction,
        ),
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
                data["X"],
                win_labels,
                win_train,
                win_calibration,
                win_validation,
            )
            net_r = _regression_report(
                data["X"],
                data["y_net_r"],
                win_train,
                win_validation,
            )
            fold_metrics = {
                "pFill": {
                    "challenger": fill["challenger"],
                    "baseline": fill["baseline"],
                },
                "pWinGivenFill": {
                    "challenger": win["challenger"],
                    "baseline": win["baseline"],
                },
                "expectedNetR": {
                    "challenger": net_r["challenger"],
                    "baseline": net_r["baseline"],
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


def train_opportunity_score(
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
    data = load_opportunity_dataset(dataset_path)
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
        data["X"],
        win_labels,
        win_train,
        win_calibration,
        win_holdout,
    )
    net_r = _regression_report(
        data["X"],
        data["y_net_r"],
        win_train,
        win_holdout,
    )
    metrics = {
        "pFill": {
            "challenger": fill["challenger"],
            "baseline": fill["baseline"],
        },
        "pWinGivenFill": {
            "challenger": win["challenger"],
            "baseline": win["baseline"],
        },
        "expectedNetR": {
            "challenger": net_r["challenger"],
            "baseline": net_r["baseline"],
        },
    }
    holdout_fill = fill["challenger_probabilities"]
    holdout_net_r_all = np.asarray(
        net_r["model"].predict(data["X"][holdout_index]),
        dtype=np.float64,
    )
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
    )
    formula_score_index = FEATURE_NAMES.index("formulaScore")
    baseline_ranking = ranking_metrics(
        actual_net_r > 0,
        actual_net_r,
        data["X"][holdout_index, formula_score_index],
        data["dates"][holdout_index],
        top_k=5,
    )
    lower_bound = block_bootstrap_lower_bound(
        challenger_ranking["daily_net_r"],
        samples=2000,
        random_state=42,
    )
    metrics["ranking"] = {
        "challenger": {
            **challenger_ranking,
            "netRLowerBound": lower_bound,
        },
        "baseline": baseline_ranking,
    }
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
    if not gate["shadowEligible"]:
        return report

    shadow = os.path.join(output_directory, "shadow")
    os.makedirs(shadow, exist_ok=True)
    _save_booster(fill["model"], os.path.join(
        shadow,
        MODEL_FILENAMES["pFill"],
    ))
    _save_booster(win["model"], os.path.join(
        shadow,
        MODEL_FILENAMES["pWinGivenFill"],
    ))
    _save_booster(net_r["model"], os.path.join(
        shadow,
        MODEL_FILENAMES["expectedNetR"],
    ))
    calibration_net_r = np.asarray(
        net_r["model"].predict(data["X"][win_calibration]),
        dtype=np.float64,
    )
    residuals = (
        data["y_net_r"][win_calibration]
        - calibration_net_r
    )
    sorted_train_net_r = np.sort(data["y_net_r"][win_train])
    tail_count = max(1, int(np.ceil(len(sorted_train_net_r) * 0.1)))
    meta = {
        "schemaVersion": SCORE_SCHEMA_VERSION,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "modelVersion": model_version,
        "trainedAt": timestamp,
        "featureNames": list(FEATURE_NAMES),
        "shadowOnly": True,
        "shadowEligible": True,
        "productionEligible": False,
        "split": split,
        "metrics": metrics,
        "calibration": {
            "pFill": fill["calibration"],
            "pWinGivenFill": win["calibration"],
            "pFillSampleCount": int(len(calibration_index)),
            "pWinGivenFillSampleCount": int(len(win_calibration)),
        },
        "risk": {
            "netRResidualLower10": round(
                float(np.percentile(residuals, 10)),
                6,
            ),
            "expectedShortfall10": round(
                float(sorted_train_net_r[:tail_count].mean()),
                6,
            ),
        },
        "ood": {
            "minimum": np.percentile(
                data["X"][train_index],
                0.5,
                axis=0,
            ).astype(float).tolist(),
            "maximum": np.percentile(
                data["X"][train_index],
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
        description="训练机会雷达独立旁路模型",
    )
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    report = train_opportunity_score(args.dataset, args.output)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
