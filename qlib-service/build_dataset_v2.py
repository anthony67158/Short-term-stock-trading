"""Build a leak-free daily multi-label challenger dataset from panel files."""

import argparse
import glob
import os
import time

import numpy as np

from factors_lib import FEATURE_NAMES, compute_factors, feature_vector
from labeling import forward_path_labels, triple_barrier_outcome


HERE = os.path.dirname(os.path.abspath(__file__))


def make_samples_from_panel(
    panel,
    *,
    min_hist=60,
    barrier_horizon=5,
    horizons=(1, 3, 5),
    take_profit_floor=0.03,
    stop_loss_floor=0.02,
    atr_multiplier=0.8,
):
    dates = np.asarray(panel["dates"]).astype(str)
    opens = np.asarray(panel["o"], dtype=float)
    highs = np.asarray(panel["h"], dtype=float)
    lows = np.asarray(panel["l"], dtype=float)
    closes = np.asarray(panel["c"], dtype=float)
    volumes = np.asarray(panel["v"], dtype=float)
    if not (
        len(dates)
        == len(opens)
        == len(highs)
        == len(lows)
        == len(closes)
        == len(volumes)
    ):
        raise ValueError("panel arrays must have equal length")

    horizons = tuple(int(horizon) for horizon in horizons)
    max_horizon = max((barrier_horizon, *horizons))
    rows = {
        "X": [],
        "dates": [],
        "y_barrier": [],
        "barrier_take_profit": [],
        "barrier_stop_loss": [],
    }
    for horizon in horizons:
        rows[f"y_return_{horizon}d"] = []
        rows[f"y_mfe_{horizon}d"] = []
        rows[f"y_mae_{horizon}d"] = []

    for index in range(min_hist, len(closes) - max_horizon):
        factors = compute_factors(
            closes[: index + 1],
            highs[: index + 1],
            lows[: index + 1],
            volumes[: index + 1],
            opens=opens[: index + 1],
        )
        features = np.asarray(feature_vector(factors), dtype=np.float32)
        if not np.isfinite(features).all():
            continue

        entry = float(closes[index])
        atr_pct = atr_multiplier * float(factors["_atr"]) / entry
        take_profit_pct = max(take_profit_floor, atr_pct)
        stop_loss_pct = max(stop_loss_floor, atr_pct)
        forward = slice(index + 1, index + barrier_horizon + 1)
        barrier = triple_barrier_outcome(
            entry_price=entry,
            future_high=highs[forward],
            future_low=lows[forward],
            take_profit_pct=take_profit_pct,
            stop_loss_pct=stop_loss_pct,
        )
        path_labels = forward_path_labels(
            close=closes,
            high=highs,
            low=lows,
            index=index,
            horizons=horizons,
        )

        rows["X"].append(features)
        rows["dates"].append(dates[index])
        rows["y_barrier"].append(barrier)
        rows["barrier_take_profit"].append(take_profit_pct)
        rows["barrier_stop_loss"].append(stop_loss_pct)
        for name, value in path_labels.items():
            rows[f"y_{name}"].append(value)

    result = {}
    for name, values in rows.items():
        if name == "X":
            result[name] = np.asarray(values, dtype=np.float32).reshape(
                (-1, len(FEATURE_NAMES))
            )
        elif name == "dates":
            result[name] = np.asarray(values)
        elif name == "y_barrier":
            result[name] = np.asarray(values, dtype=np.int8)
        else:
            result[name] = np.asarray(values, dtype=np.float32)
    return result


def load_panel(path):
    with np.load(path, allow_pickle=True) as data:
        return {
            "dates": data["dates"],
            "o": data["o"],
            "h": data["h"],
            "l": data["l"],
            "c": data["c"],
            "v": data["v"],
        }


def build_dataset(panel_dir, *, min_hist, barrier_horizon, horizons):
    files = sorted(glob.glob(os.path.join(panel_dir, "*_*.npz")))
    chunks = []
    started = time.time()
    for number, path in enumerate(files, start=1):
        samples = make_samples_from_panel(
            load_panel(path),
            min_hist=min_hist,
            barrier_horizon=barrier_horizon,
            horizons=horizons,
        )
        code = os.path.basename(path)[:-4].replace("_", ".")
        samples["codes"] = np.full(len(samples["dates"]), code)
        chunks.append(samples)
        if number % 100 == 0:
            count = sum(len(chunk["dates"]) for chunk in chunks)
            print(
                f"  {number}/{len(files)} samples={count} "
                f"elapsed={time.time() - started:.0f}s",
                flush=True,
            )

    if not chunks:
        raise RuntimeError("no panel files produced samples")
    keys = chunks[0].keys()
    dataset = {
        key: np.concatenate([chunk[key] for chunk in chunks])
        for key in keys
    }
    dataset["feat_names"] = np.asarray(FEATURE_NAMES)
    return dataset


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--panel", default="panel_full477")
    parser.add_argument("--out", default="full477/dataset_v2.npz")
    parser.add_argument("--min-hist", type=int, default=60)
    parser.add_argument("--barrier-horizon", type=int, default=5)
    parser.add_argument("--horizons", default="1,3,5")
    args = parser.parse_args()

    horizons = tuple(
        int(value.strip())
        for value in args.horizons.split(",")
        if value.strip()
    )
    dataset = build_dataset(
        os.path.join(HERE, args.panel),
        min_hist=args.min_hist,
        barrier_horizon=args.barrier_horizon,
        horizons=horizons,
    )
    output = os.path.join(HERE, args.out)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    np.savez_compressed(output, **dataset)
    counts = dict(
        zip(
            *np.unique(dataset["y_barrier"], return_counts=True),
        )
    )
    print(
        f"[saved] {output} samples={len(dataset['dates'])} "
        f"features={dataset['X'].shape[1]} barrier_counts={counts}"
    )


if __name__ == "__main__":
    main()
