"""Build causal V2.1 dual-head samples from validated 5-minute bars."""

import argparse
import glob
import json
import os
import time

import numpy as np

from build_intraday_dataset import (
    FEATURE_NAMES,
    _load_cache_panel,
    _minute_features_from_arrays,
    _panel_arrays,
    _session_groups,
    barrier_counts,
)
from labeling import triple_barrier_outcome


FIRST_SIGNAL_TIME = "10:00:00"
LAST_SIGNAL_TIME = "14:30:00"
NEXT_30M_BARS = 6


def session_bucket(as_of):
    hhmm = str(as_of)[11:16]
    if hhmm == "11:30":
        return "noon"
    if hhmm < "12:00":
        return "morning"
    return "afternoon"


def _barrier(entry, indices, arrays, *, take_profit_pct, stop_loss_pct):
    return triple_barrier_outcome(
        entry_price=float(entry),
        future_high=arrays["high"][indices],
        future_low=arrays["low"][indices],
        take_profit_pct=take_profit_pct,
        stop_loss_pct=stop_loss_pct,
    )


def make_intraday_v21_samples(
    panel,
    *,
    sequence_length=60,
    minimum_bars_per_day=40,
    next30m_take_profit_pct=0.0045,
    next30m_stop_loss_pct=0.003,
    close_take_profit_pct=0.008,
    close_stop_loss_pct=0.005,
):
    """Create dual-head samples whose features end exactly at each as-of bar."""
    if not isinstance(sequence_length, int) or sequence_length < 2:
        raise ValueError("sequence_length 必须至少为 2")
    if not isinstance(minimum_bars_per_day, int) or minimum_bars_per_day < 1:
        raise ValueError("minimum_bars_per_day 必须为正整数")

    times, arrays = _panel_arrays(panel)
    features = _minute_features_from_arrays(times, arrays)
    rows = {
        "X": [],
        "dates": [],
        "as_of": [],
        "entry_time": [],
        "entry_open": [],
        "session_bucket": [],
        "y_next30m": [],
        "y_session_close": [],
    }
    for signal_date, day_indices in _session_groups(times):
        if (
            len(day_indices) < minimum_bars_per_day
            or not times[int(day_indices[-1])].endswith("15:00:00")
        ):
            continue
        for day_position, raw_index in enumerate(day_indices):
            signal_index = int(raw_index)
            signal_time = times[signal_index][11:]
            if not FIRST_SIGNAL_TIME <= signal_time <= LAST_SIGNAL_TIME:
                continue
            future_indices = day_indices[day_position + 1 :]
            if len(future_indices) < NEXT_30M_BARS:
                continue
            sequence_start = signal_index - sequence_length + 1
            if sequence_start < 0:
                continue
            entry_index = int(future_indices[0])
            entry = float(arrays["open"][entry_index])
            next30_indices = future_indices[:NEXT_30M_BARS]
            rows["X"].append(features[sequence_start : signal_index + 1])
            rows["dates"].append(signal_date)
            rows["as_of"].append(times[signal_index])
            rows["entry_time"].append(times[entry_index])
            rows["entry_open"].append(entry)
            rows["session_bucket"].append(session_bucket(times[signal_index]))
            rows["y_next30m"].append(
                _barrier(
                    entry,
                    next30_indices,
                    arrays,
                    take_profit_pct=next30m_take_profit_pct,
                    stop_loss_pct=next30m_stop_loss_pct,
                )
            )
            rows["y_session_close"].append(
                _barrier(
                    entry,
                    future_indices,
                    arrays,
                    take_profit_pct=close_take_profit_pct,
                    stop_loss_pct=close_stop_loss_pct,
                )
            )

    count = len(rows["as_of"])
    return {
        "X": np.asarray(rows["X"], dtype=np.float32).reshape(
            (-1, sequence_length, len(FEATURE_NAMES))
        ),
        "dates": np.asarray(rows["dates"]),
        "as_of": np.asarray(rows["as_of"]),
        "entry_time": np.asarray(rows["entry_time"]),
        "entry_open": np.asarray(rows["entry_open"], dtype=np.float32),
        "session_bucket": np.asarray(rows["session_bucket"]),
        "y_next30m": np.asarray(rows["y_next30m"], dtype=np.int8),
        "y_session_close": np.asarray(rows["y_session_close"], dtype=np.int8),
        "feature_names": np.asarray(FEATURE_NAMES),
        "sample_count": count,
    }


def build_dataset_from_cache(
    cache_root,
    *,
    sequence_length=60,
    minimum_bars_per_day=40,
):
    paths = sorted(
        glob.glob(
            os.path.join(os.fspath(cache_root), "**", "*.npz"),
            recursive=True,
        )
    )
    if not paths:
        raise RuntimeError("未找到分钟缓存文件")
    panels_by_code = {}
    for path in paths:
        code, panel = _load_cache_panel(path)
        panels_by_code.setdefault(code, []).append(panel)

    chunks = []
    fields = (
        "trade_time",
        "open",
        "high",
        "low",
        "close",
        "vol",
        "amount",
    )
    for code, panels in sorted(panels_by_code.items()):
        panel = {
            field: np.concatenate([current[field] for current in panels])
            for field in fields
        }
        if not len(panel["trade_time"]):
            continue
        samples = make_intraday_v21_samples(
            panel,
            sequence_length=sequence_length,
            minimum_bars_per_day=minimum_bars_per_day,
        )
        if not samples["sample_count"]:
            continue
        samples["codes"] = np.full(samples["sample_count"], code)
        chunks.append(samples)
    if not chunks:
        raise RuntimeError("分钟缓存未生成任何 V2.1 盘中样本")

    output_fields = (
        "X",
        "dates",
        "as_of",
        "entry_time",
        "entry_open",
        "session_bucket",
        "y_next30m",
        "y_session_close",
        "codes",
    )
    dataset = {
        field: np.concatenate([chunk[field] for chunk in chunks])
        for field in output_fields
    }
    dataset["feature_names"] = np.asarray(FEATURE_NAMES)
    return dataset


def main():
    parser = argparse.ArgumentParser(
        description="从验证后的 5 分钟缓存构建 V2.1 盘中双头训练集",
    )
    parser.add_argument("--cache-root", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--sequence-length", type=int, default=60)
    parser.add_argument("--minimum-bars-per-day", type=int, default=40)
    args = parser.parse_args()
    dataset = build_dataset_from_cache(
        args.cache_root,
        sequence_length=args.sequence_length,
        minimum_bars_per_day=args.minimum_bars_per_day,
    )
    output = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    np.savez_compressed(
        output,
        **dataset,
        created_at=np.asarray([int(time.time())], dtype=np.int64),
        target_rule=np.asarray([
            "V2.1 dual-head: next30m tp=0.45% sl=0.30%; "
            "sessionClose tp=0.80% sl=0.50%; next-bar-open entry"
        ]),
    )
    print(json.dumps({
        "out": output,
        "samples": int(len(dataset["dates"])),
        "codes": int(len(np.unique(dataset["codes"]))),
        "sequence_shape": list(dataset["X"].shape),
        "next30m_counts": barrier_counts(dataset["y_next30m"]),
        "session_close_counts": barrier_counts(dataset["y_session_close"]),
    }, ensure_ascii=False))
    print("INTRADAY_V21_DATASET_BUILD_OK")


if __name__ == "__main__":
    main()
