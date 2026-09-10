"""Offline same-split bake-off for trigger-observation review features."""

import argparse
import json
import os
import time

import numpy as np

from opportunity_evaluation import (
    apply_probability_calibrator,
    binary_metrics,
    block_bootstrap_lower_bound,
    fit_probability_calibrator,
    regression_metrics,
)
from opportunity_history import normalize_history_outcomes
from opportunity_review_dataset import build_opportunity_review_dataset
from poc_v3_model_bakeoff import (
    CatBoostFamily,
    LightGbmFamily,
    _probability,
    _ranking,
    active_feature_mask,
    clip_labels,
    compose_expected_net_r,
    constant_probability_metrics,
    rank_training_data,
    relevance_labels,
)
from v3_poc_dataset import interval_expanding_folds


FAMILIES = ("lightgbm", "catboost")


def load_dataset(path):
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    return build_opportunity_review_dataset(
        normalize_history_outcomes(payload)
    )


def _mean(values):
    return round(float(np.mean(list(values))), 6)


def run_fold(family, dataset, fold):
    train = fold["train"]
    calibration = fold["calibration"]
    validation = fold["validation"]
    mask = active_feature_mask(dataset["X"][train])
    X_train = dataset["X"][train][:, mask]
    X_calibration = dataset["X"][calibration][:, mask]
    X_validation = dataset["X"][validation][:, mask]
    positive = train[dataset["y_net_r"][train] > 0]
    negative = train[dataset["y_net_r"][train] <= 0]
    positive_labels, _ = clip_labels(dataset["y_net_r"][positive])
    negative_labels, _ = clip_labels(dataset["y_net_r"][negative])
    quantile_labels, _ = clip_labels(dataset["y_net_r"][train])

    win_model = family.classifier()
    win_model.fit(X_train, dataset["y_win"][train])
    win_payoff = family.regressor()
    win_payoff.fit(dataset["X"][positive][:, mask], positive_labels)
    loss_payoff = family.regressor()
    loss_payoff.fit(dataset["X"][negative][:, mask], negative_labels)
    quantile = family.quantile()
    quantile.fit(X_train, quantile_labels)
    labels, _ = relevance_labels(dataset["y_net_r"][train])
    rank_data = rank_training_data(dataset, train, labels, mask)
    ranker = family.ranker()
    family.fit_ranker(ranker, rank_data)

    calibrator = fit_probability_calibrator(
        dataset["y_win"][calibration],
        _probability(win_model, X_calibration),
    )
    p_win = apply_probability_calibrator(
        _probability(win_model, X_validation),
        calibrator,
    )
    expected_net_r = compose_expected_net_r(
        p_win,
        win_payoff.predict(X_validation),
        loss_payoff.predict(X_validation),
    )
    q10 = np.asarray(quantile.predict(X_validation), dtype=np.float64)
    rank_scores = np.asarray(ranker.predict(X_validation), dtype=np.float64)
    win_metrics = binary_metrics(dataset["y_win"][validation], p_win)
    win_baseline = constant_probability_metrics(
        dataset["y_win"][train],
        dataset["y_win"][validation],
    )
    net_metrics = regression_metrics(
        dataset["y_net_r"][validation],
        expected_net_r,
    )
    median_baseline = np.full(
        len(validation),
        float(np.median(dataset["y_net_r"][train])),
    )
    baseline_metrics = regression_metrics(
        dataset["y_net_r"][validation],
        median_baseline,
    )
    return {
        "metadata": fold["metadata"],
        "pWinBrier": win_metrics["brier"],
        "pWinBrierSkill": round(
            1 - win_metrics["brier"] / win_baseline["brier"],
            6,
        ),
        "netRMae": net_metrics["mae"],
        "netRMaeSkill": round(
            1 - net_metrics["mae"] / baseline_metrics["mae"],
            6,
        ),
        "q10Coverage": round(float(np.mean(
            dataset["y_net_r"][validation] >= q10
        )), 6),
        "valueRanking": _ranking(
            dataset["y_net_r"][validation],
            expected_net_r,
            dataset,
            validation,
        ),
        "rankerRanking": _ranking(
            dataset["y_net_r"][validation],
            rank_scores,
            dataset,
            validation,
        ),
    }


def aggregate(folds):
    value_daily = {}
    ranker_daily = {}
    for fold in folds:
        value_daily.update(
            fold["valueRanking"]["top5"]["daily_net_r"]
        )
        ranker_daily.update(
            fold["rankerRanking"]["top5"]["daily_net_r"]
        )
    return {
        "pWinBrierSkill": _mean([
            fold["pWinBrierSkill"] for fold in folds
        ]),
        "netRMaeSkill": _mean([
            fold["netRMaeSkill"] for fold in folds
        ]),
        "q10Coverage": _mean([
            fold["q10Coverage"] for fold in folds
        ]),
        "valueTop5MeanNetR": _mean(value_daily.values()),
        "valueTop5LowerBound": block_bootstrap_lower_bound(
            value_daily,
            samples=5000,
            random_state=42,
        ),
        "rankerTop5MeanNetR": _mean(ranker_daily.values()),
        "rankerTop5LowerBound": block_bootstrap_lower_bound(
            ranker_daily,
            samples=5000,
            random_state=42,
        ),
    }


def run(path, output, *, seed=42, estimators=180, threads=4):
    dataset = load_dataset(path)
    folds = interval_expanding_folds(dataset, n_splits=3)
    families = {}
    for name, factory in (
        ("lightgbm", LightGbmFamily),
        ("catboost", CatBoostFamily),
    ):
        family = factory(estimators, threads, seed)
        values = [
            run_fold(family, dataset, fold)
            for fold in folds
        ]
        families[name] = {
            "version": family.version,
            "folds": values,
            "aggregate": aggregate(values),
        }
    eligible = [
        name
        for name, value in families.items()
        if (
            value["aggregate"]["pWinBrierSkill"] > 0
            and value["aggregate"]["netRMaeSkill"] > 0
            and value["aggregate"]["valueTop5LowerBound"] > 0
            and 0.88 <= value["aggregate"]["q10Coverage"] <= 0.92
        )
    ]
    report = {
        "schemaVersion": "v3-review-model-bakeoff.v1",
        "generatedAt": int(time.time() * 1000),
        "seed": seed,
        "dataset": {
            "samples": len(dataset["X"]),
            "dates": len(set(dataset["dates"].tolist())),
            "features": dataset["X"].shape[1],
            "summary": dataset["summary"],
            "folds": [fold["metadata"] for fold in folds],
        },
        "families": families,
        "decision": {
            "state": (
                "REVIEW_MODEL_CANDIDATE"
                if len(eligible) == 1
                else "NO_REVIEW_MODEL"
            ),
            "candidate": eligible[0] if len(eligible) == 1 else None,
        },
    }
    os.makedirs(output, exist_ok=True)
    with open(
        os.path.join(output, "report.json"),
        "w",
        encoding="utf-8",
    ) as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--estimators", type=int, default=180)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    report = run(
        args.input,
        args.output_dir,
        seed=args.seed,
        estimators=args.estimators,
        threads=args.threads,
    )
    print(json.dumps(report["decision"], ensure_ascii=False))


if __name__ == "__main__":
    main()
