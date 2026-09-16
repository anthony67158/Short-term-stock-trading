"""Purged execution-model evaluation on sealed candidate-union minute labels."""

import argparse
import json
import sqlite3
from decimal import Decimal
from pathlib import Path

import joblib
import numpy as np
from lightgbm import LGBMClassifier, LGBMRegressor
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, mean_absolute_error, mean_pinball_loss

from platform_app.modules.experiments.quant_model_trainer import (
    RANDOM_STATE, QuantModelError, _file_sha256, _verified_database, load_enriched_training_data,
)


def execution_splits(dates, *, folds=5, warmup=126, calibration=63, gap=5):
    unique = np.unique(dates)
    start = warmup + calibration + 2 * gap
    if len(unique) - start < folds * 20:
        raise QuantModelError("EXECUTION_DATE_SUPPORT_INSUFFICIENT")
    result = []
    for block in np.array_split(unique[start:], folds):
        index = int(np.searchsorted(unique, block[0]))
        cal_end = index - gap
        cal_start = cal_end - calibration
        train_end = cal_start - gap
        result.append((
            dates < unique[train_end],
            (dates >= unique[cal_start]) & (dates < unique[cal_end]),
            (dates >= block[0]) & (dates <= block[-1]),
        ))
    return result


def scenario_weights(dates, episodes):
    """Each date has equal total weight; scenarios share their episode weight."""
    keys = np.array([f"{d}:{e}" for d, e in zip(dates, episodes, strict=True)])
    _, inverse, counts = np.unique(keys, return_inverse=True, return_counts=True)
    weight = 1.0 / counts[inverse]
    for date in np.unique(dates):
        mask = dates == date
        weight[mask] /= weight[mask].sum()
    return weight


def requested_notional_return(row):
    if row["filled_shares"] == 0:
        return 0.0
    shares = Decimal(row["filled_shares"])
    pnl = (
        (Decimal(row["exit_price"]) - Decimal(row["entry_price"])) * shares
        - Decimal(row["buy_fees_cny"]) - Decimal(row["sell_fees_cny"])
    )
    return float(pnl / Decimal(row["target_notional_cny"]))


def logit(values):
    clipped = np.clip(values, 1e-6, 1 - 1e-6)
    return np.log(clipped / (1 - clipped)).reshape(-1, 1)


def train_fold(x, targets, dates, weights, masks, *, iterations=120, threads=2):
    train, calibration, test = masks
    def fit_weights(mask):
        return weights[mask] / weights[mask].mean()

    common = dict(
        n_estimators=iterations, learning_rate=0.05, num_leaves=15, max_depth=5,
        min_child_samples=100, reg_lambda=1.0, random_state=RANDOM_STATE,
        n_jobs=threads, verbosity=-1, deterministic=True, force_col_wise=True,
    )
    fitted, predictions, metrics = {}, {}, {}
    available = targets["fillFraction"] > 0
    for name in ("pFill", "pFullFill", "pWinGivenFill"):
        y = targets[name]
        valid = available if name == "pWinGivenFill" else np.ones(len(x), dtype=bool)
        tr, ca, te = train & valid, calibration & valid, test & valid
        if any(len(np.unique(y[mask])) < 2 for mask in (tr, ca)):
            raise QuantModelError(f"EXECUTION_CLASS_SUPPORT_INSUFFICIENT:{name}")
        model = LGBMClassifier(**common).fit(x[tr], y[tr], sample_weight=fit_weights(tr))
        calibrator = LogisticRegression(C=1, random_state=RANDOM_STATE).fit(
            logit(model.predict_proba(x[ca])[:, 1]), y[ca], sample_weight=fit_weights(ca),
        )
        raw = model.predict_proba(x[test])[:, 1]
        calibrated = calibrator.predict_proba(logit(raw))[:, 1]
        predictions[name] = calibrated
        local = valid[test]
        baseline = float(np.average(y[tr], weights=weights[tr]))
        metrics[name] = {
            "samples": int(te.sum()),
            "rawBrier": float(brier_score_loss(y[te], raw[local], sample_weight=weights[te])),
            "calibratedBrier": float(brier_score_loss(
                y[te], calibrated[local], sample_weight=weights[te],
            )),
            "trainingPrevalenceBrier": float(brier_score_loss(
                y[te], np.full(te.sum(), baseline), sample_weight=weights[te],
            )),
        }
        fitted[name] = {"model": model, "calibrator": calibrator}
    for name in ("fillFraction", "netReturnOnRequestedNotional"):
        y = targets[name]
        model = LGBMRegressor(**common).fit(x[train], y[train], sample_weight=fit_weights(train))
        offset = float(np.average(y[calibration] - model.predict(x[calibration]),
                                  weights=weights[calibration]))
        predicted = model.predict(x[test]) + offset
        if name == "fillFraction":
            predicted = np.clip(predicted, 0, 1)
        predictions[name] = predicted
        metrics[name] = {
            "mae": float(mean_absolute_error(y[test], predicted, sample_weight=weights[test])),
            "trainingMeanMae": float(mean_absolute_error(
                y[test], np.full(test.sum(), np.average(y[train], weights=weights[train])),
                sample_weight=weights[test],
            )),
        }
        fitted[name] = {"model": model, "offset": offset}
    tr, ca, te = train & available, calibration & available, test & available
    if min(tr.sum(), ca.sum(), te.sum()) < 100:
        raise QuantModelError("EXECUTION_CONDITIONAL_SUPPORT_INSUFFICIENT")
    y = targets["conditionalReturn"]
    for name, alpha in (("q10", .1), ("q50", .5), ("q90", .9)):
        model = LGBMRegressor(objective="quantile", alpha=alpha, **common).fit(
            x[tr], y[tr], sample_weight=fit_weights(tr),
        )
        # Weighted empirical rolling correction, not an exchangeability guarantee.
        residual = y[ca] - model.predict(x[ca])
        order = np.argsort(residual)
        cumulative = np.cumsum(weights[ca][order])
        offset = float(residual[order][np.searchsorted(cumulative, alpha * cumulative[-1])])
        predictions[name] = model.predict(x[test]) + offset
        fitted[name] = {"model": model, "offset": offset}
    ordered = np.sort(np.column_stack([predictions[n] for n in ("q10", "q50", "q90")]), axis=1)
    for index, (name, alpha) in enumerate((("q10", .1), ("q50", .5), ("q90", .9))):
        predictions[name] = ordered[:, index]
        metrics[name] = {"pinball": float(mean_pinball_loss(
            y[te], ordered[available[test], index], alpha=alpha, sample_weight=weights[te],
        ))}
    covered = (y[test] >= ordered[:, 0]) & (y[test] <= ordered[:, 2])
    metrics["q10Q90CoverageGivenFill"] = float(np.average(
        covered[available[test]], weights=weights[te],
    ))
    metrics["split"] = {
        name: {"start": int(dates[mask].min()), "end": int(dates[mask].max()),
               "scenarios": int(mask.sum())}
        for name, mask in zip(("train", "calibration", "test"), masks, strict=True)
    }
    return fitted, predictions, metrics


def run(episode_root, label_root, ranking_root, output):
    data, lineage = load_enriched_training_data(
        episode_dataset_root=episode_root, label_dataset_root=label_root,
        ranking_dataset_root=ranking_root,
    )
    _, path = _verified_database(label_root, "label-dataset.v2")
    with sqlite3.connect(f"{path.as_uri()}?mode=ro&immutable=1", uri=True) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute(
            "SELECT decision_date,episode_id,fill_ratio,p_fill_label,"
            "entry_price,exit_price,filled_shares,buy_fees_cny,sell_fees_cny,target_notional_cny "
            "FROM episode_labels ORDER BY decision_date,episode_id,target_shares"
        ).fetchall()
    dates = np.asarray([int(r[0]) for r in rows])
    if not np.array_equal(dates, data.scenario_dates):
        raise QuantModelError("EXECUTION_SCENARIO_ALIGNMENT_INVALID")
    fill = np.asarray([float(r[2]) for r in rows])
    targets = {
        "pFill": np.asarray([r[3] for r in rows]), "pFullFill": data.p_full_fill,
        "pWinGivenFill": data.p_win, "fillFraction": fill,
        "conditionalReturn": data.net_return,
        "netReturnOnRequestedNotional": np.asarray([requested_notional_return(r) for r in rows]),
    }
    weights = scenario_weights(dates, [r[1] for r in rows])
    output.mkdir(parents=True, exist_ok=False)
    protocol = {
        "schemaVersion": "execution-walk-forward.v1", "lineage": lineage,
        "folds": 5, "warmupSessions": 126, "calibrationSessions": 63, "purgeSessions": 5,
        "iterations": 120, "modelSourceSha256": _file_sha256(Path(__file__)),
        "featureNames": data.scenario_feature_names, "randomState": RANDOM_STATE,
        "usage": "DEVELOPMENT_ONLY", "productionReady": False,
        "calibration": "ROLLING_WEIGHTED_EMPIRICAL_NO_CONFORMAL_GUARANTEE",
    }
    (output / "protocol.json").write_text(json.dumps(protocol, indent=2) + "\n")
    reports = []
    for index, masks in enumerate(execution_splits(dates), 1):
        fitted, predictions, metrics = train_fold(data.scenario_x, targets, dates, weights, masks)
        joblib.dump(fitted, output / f"fold-{index}.joblib")
        test = masks[2]
        np.savez_compressed(
            output / f"fold-{index}.npz", dates=dates[test], boards=data.scenario_boards[test],
            weights=weights[test], **predictions,
            **{f"actual_{name}": value[test] for name, value in targets.items()},
        )
        reports.append(metrics)
        (output / "evaluation.json").write_text(json.dumps({
            "protocol": protocol, "completedFolds": len(reports), "folds": reports,
        }, indent=2) + "\n")
        print(json.dumps({"fold": index, "metrics": metrics}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("episode-root", "label-root", "ranking-root", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    run(args.episode_root, args.label_root, args.ranking_root, args.output)


if __name__ == "__main__":
    main()
