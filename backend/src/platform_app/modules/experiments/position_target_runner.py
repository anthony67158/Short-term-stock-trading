"""Train a shared target-position value function; research-only, never deployable."""

import argparse
import itertools
import json
import math
import sqlite3
from pathlib import Path

import joblib
import numpy as np
from lightgbm import LGBMRegressor

from platform_app.modules.experiments.execution_walk_forward import execution_splits, scenario_weights
from platform_app.modules.experiments.position_target_value import POLICY, target_value_labels
from platform_app.modules.experiments.quant_model_trainer import (
    ENRICHED_BASE_FEATURE_NAMES, RANDOM_STATE, _file_sha256, _verified_database,
    load_enriched_training_data,
)

FEATURES = (*ENRICHED_BASE_FEATURE_NAMES, "logCurrentShares", "logCurrentNotional",
            "currentToMedianAmount", "targetToCurrentShares")


def state_features(base, shares, snapshot, target):
    notional = shares * float(snapshot)
    return [*base, math.log1p(shares), math.log1p(notional),
            notional / max(math.expm1(float(base[11])), 1), target / shares]


def build_data(episode_root, label_root, ranking_root, market_root):
    data, lineage = load_enriched_training_data(
        episode_dataset_root=episode_root, label_dataset_root=label_root,
        ranking_dataset_root=ranking_root,
    )
    _, label_path = _verified_database(label_root, "label-dataset.v2")
    _, episode_path = _verified_database(episode_root, "episode-dataset.v4")
    market_manifest, market_path = _verified_database(market_root, "market-dataset.v4")
    if market_manifest["databaseSha256"] != lineage["episodeManifest"]["marketDatabaseSha256"]:
        raise ValueError("POSITION_TARGET_MARKET_LINEAGE_MISMATCH")
    with sqlite3.connect(f"{label_path.as_uri()}?mode=ro&immutable=1", uri=True) as db:
        db.row_factory = sqlite3.Row
        keys = db.execute(
            "SELECT episode_id FROM episode_labels ORDER BY decision_date,episode_id,target_shares"
        ).fetchall()
        base_by_episode = {
            row[0]: x[:len(ENRICHED_BASE_FEATURE_NAMES)]
            for row, x in zip(keys, data.scenario_x, strict=True)
        }
        db.execute("ATTACH DATABASE ? AS episodes", (
            f"{episode_path.as_uri()}?mode=ro&immutable=1",
        ))
        db.execute("ATTACH DATABASE ? AS market", (
            f"{market_path.as_uri()}?mode=ro&immutable=1",
        ))
        rows = db.execute(
            "WITH states AS (SELECT DISTINCT episode_id,instrument_id,board,filled_shares "
            "FROM episode_labels WHERE filled_shares>0) "
            "SELECT s.*,r0.trade_date AS snapshot_date,r1.trade_date AS action_date,"
            "r4.trade_date AS terminal_date,d0.close AS snapshot_price,"
            "d1.open AS action_open,d4.close AS terminal_close,"
            "b.trade_date,b.bar_end_shanghai,b.volume_shares "
            "FROM states s "
            "JOIN episodes.episode_minute_requirements r0 "
            "ON r0.episode_id=s.episode_id AND r0.session_offset=0 "
            "JOIN episodes.episode_minute_requirements r1 "
            "ON r1.episode_id=s.episode_id AND r1.session_offset=1 "
            "JOIN episodes.episode_minute_requirements r4 "
            "ON r4.episode_id=s.episode_id AND r4.session_offset=4 "
            "JOIN market.daily_bars d0 ON d0.instrument_id=s.instrument_id "
            "AND d0.trade_date=r0.trade_date "
            "JOIN market.daily_bars d1 ON d1.instrument_id=s.instrument_id "
            "AND d1.trade_date=r1.trade_date "
            "JOIN market.daily_bars d4 ON d4.instrument_id=s.instrument_id "
            "AND d4.trade_date=r4.trade_date "
            "JOIN episodes.episode_minute_bars b ON b.instrument_id=s.instrument_id "
            "AND b.trade_date=r1.trade_date AND substr(b.bar_end_shanghai,-8)<='10:00:00' "
            "ORDER BY snapshot_date,s.episode_id,s.filled_shares,b.bar_end_shanghai"
        )
        x, y, dates, states, episode_ids, targets, boards = [], [], [], [], [], [], []
        for (episode, shares), group in itertools.groupby(
            rows, key=lambda row: (row["episode_id"], row["filled_shares"]),
        ):
            bars = list(group)
            first = bars[0]
            labels = target_value_labels(
                board=first["board"], current_shares=shares,
                snapshot_price=first["snapshot_price"], action_date=first["action_date"],
                action_open=first["action_open"], terminal_date=first["terminal_date"],
                terminal_close=first["terminal_close"], action_bars=[
                    {"tradeDate": r["trade_date"], "barEndShanghai": r["bar_end_shanghai"],
                     "volumeShares": r["volume_shares"]} for r in bars
                ],
            )
            for label in labels:
                x.append(state_features(base_by_episode[episode], shares,
                                        first["snapshot_price"], label["targetShares"]))
                y.append(float(label["deltaReturnVsHold"]))
                dates.append(int(first["snapshot_date"]))
                states.append(f"{episode}:{shares}")
                episode_ids.append(episode)
                targets.append(float(label["targetRatio"]))
                boards.append(first["board"])
    return {
        "x": np.asarray(x, dtype=np.float32), "y": np.asarray(y),
        "dates": np.asarray(dates), "states": np.asarray(states),
        "episodes": np.asarray(episode_ids), "ratios": np.asarray(targets),
        "boards": np.asarray(boards),
    }, lineage


def choose_values(predicted, actual, states, ratios):
    # Exact HOLD is always zero; compare actions relative to the same state's fitted HOLD.
    output = []
    for state in dict.fromkeys(states):
        indices = np.flatnonzero(states == state)
        hold = indices[ratios[indices] == 1][0]
        relative = predicted[indices] - predicted[hold]
        # Prefer HOLD on a tie, then the smaller change.
        order = sorted(range(len(indices)), key=lambda i: abs(ratios[indices[i]] - 1))
        best = max(order, key=lambda i: relative[i])
        selected = indices[best]
        output.append((selected, actual[selected], float(actual[indices].max() - actual[selected])))
    return output


def run(args):
    values, lineage = build_data(
        args.episode_root, args.label_root, args.ranking_root, args.market_root,
    )
    root = args.output
    root.mkdir(parents=True, exist_ok=False)
    protocol = {
        "policy": POLICY, "lineage": lineage, "featureNames": FEATURES,
        "sourceSha256": _file_sha256(Path(__file__)), "iterations": 120,
        "labelSourceSha256": _file_sha256(Path(__file__).with_name("position_target_value.py")),
        "folds": 5, "calibrationSessions": 63, "purgeSessions": 5,
        "randomState": RANDOM_STATE, "usage": "DEVELOPMENT_ONLY", "productionReady": False,
    }
    (root / "protocol.json").write_text(json.dumps(protocol, indent=2) + "\n")
    np.savez_compressed(root / "training-data.npz", **values)
    x, y, dates = values["x"], values["y"], values["dates"]
    weights = scenario_weights(dates, values["episodes"])
    reports = []
    for index, (train, calibration, test) in enumerate(execution_splits(dates), 1):
        model = LGBMRegressor(
            n_estimators=120, learning_rate=.05, num_leaves=15, max_depth=5,
            min_child_samples=100, reg_lambda=1, n_jobs=2, verbosity=-1,
            random_state=RANDOM_STATE, deterministic=True, force_col_wise=True,
        ).fit(x[train], y[train], sample_weight=weights[train] / weights[train].mean())
        predicted = model.predict(x[test])
        chosen = choose_values(predicted, y[test], values["states"][test], values["ratios"][test])
        indices = np.array([r[0] for r in chosen])
        deltas = np.array([r[1] for r in chosen])
        day_values = [float(deltas[dates[test][indices] == d].mean())
                      for d in np.unique(dates[test])]
        report = {
            "fold": index, "start": int(dates[test].min()), "end": int(dates[test].max()),
            "states": len(chosen), "meanDailyDeltaVsHold": float(np.mean(day_values)),
            "meanRegret": float(np.mean([r[2] for r in chosen])),
            "holdFraction": float(np.mean(values["ratios"][test][indices] == 1)),
            "calibrationUsed": False,
            "note": "Target-independent mean correction cancels against paired HOLD.",
        }
        joblib.dump(model, root / f"fold-{index}.joblib")
        np.savez_compressed(root / f"fold-{index}.npz", predictions=predicted, actual=y[test],
                            dates=dates[test], states=values["states"][test],
                            ratios=values["ratios"][test], boards=values["boards"][test])
        reports.append(report)
        (root / "evaluation.json").write_text(json.dumps({
            "protocol": protocol, "completedFolds": len(reports), "folds": reports,
        }, indent=2) + "\n")
        print(json.dumps(report), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("episode-root", "label-root", "ranking-root", "market-root", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
