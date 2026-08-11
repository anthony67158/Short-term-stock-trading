"""Build T+1-compliant day-end sequence samples from minute OHLCV bars."""

import argparse
import glob
import json
import os
import time
from datetime import datetime

import numpy as np

from labeling import triple_barrier_outcome
FEATURE_NAMES = (
    "log_return",
    "range_pct",
    "body_pct",
    "volume_log_ratio",
    "time_sin",
    "time_cos",
)
_TIME_FORMAT = "%Y-%m-%d %H:%M:%S"


def _panel_arrays(panel):
    required = ("trade_time", "open", "high", "low", "close", "vol", "amount")
    if not isinstance(panel, dict) or any(name not in panel for name in required):
        raise ValueError("分钟面板缺少必要字段")
    times = np.asarray(panel["trade_time"]).astype(str)
    arrays = {
        name: np.asarray(panel[name], dtype=float)
        for name in required[1:]
    }
    if not len(times) or any(len(values) != len(times) for values in arrays.values()):
        raise ValueError("分钟面板字段长度不一致或为空")
    if any(not np.isfinite(values).all() for values in arrays.values()):
        raise ValueError("分钟面板包含非有限数值")
    if np.any(arrays["open"] <= 0) or np.any(arrays["close"] <= 0):
        raise ValueError("分钟开收盘价必须为正")
    parsed = []
    for value in times:
        try:
            parsed.append(datetime.strptime(value, _TIME_FORMAT))
        except ValueError as error:
            raise ValueError("分钟时间格式无效") from error
    if any(next_time <= current for current, next_time in zip(parsed, parsed[1:])):
        raise ValueError("分钟数据必须按时间严格升序")
    return times, arrays


def minute_features(panel):
    """Return six causal, scale-independent minute features."""
    times, arrays = _panel_arrays(panel)
    return _minute_features_from_arrays(times, arrays)


def _minute_features_from_arrays(times, arrays):
    """Compute features after the panel has already passed validation."""
    opens = arrays["open"]
    highs = arrays["high"]
    lows = arrays["low"]
    closes = arrays["close"]
    volumes = arrays["vol"]

    log_return = np.zeros(len(closes), dtype=np.float32)
    log_return[1:] = np.log(closes[1:] / closes[:-1])
    range_pct = (highs - lows) / closes
    body_pct = (closes - opens) / opens

    cumulative = np.concatenate(([0.0], np.cumsum(volumes)))
    rolling_volume = np.empty(len(volumes), dtype=float)
    for index in range(len(volumes)):
        left = max(0, index - 19)
        rolling_volume[index] = (
            cumulative[index + 1] - cumulative[left]
        ) / (index - left + 1)
    volume_log_ratio = np.log1p(volumes) - np.log1p(rolling_volume)

    minute_of_day = np.fromiter(
        (
            int(value[11:13]) * 60 + int(value[14:16])
            for value in times
        ),
        dtype=float,
        count=len(times),
    )
    session_phase = (minute_of_day - 570.0) / 330.0
    features = np.column_stack(
        (
            log_return,
            range_pct,
            body_pct,
            volume_log_ratio,
            np.sin(2.0 * np.pi * session_phase),
            np.cos(2.0 * np.pi * session_phase),
        )
    )
    if not np.isfinite(features).all():
        raise ValueError("分钟特征包含非有限数值")
    return features.astype(np.float32)


def _session_groups(times):
    dates = np.asarray([value[:10] for value in times])
    groups = []
    start = 0
    for index in range(1, len(dates) + 1):
        if index == len(dates) or dates[index] != dates[start]:
            groups.append((dates[start], np.arange(start, index)))
            start = index
    return groups


def make_day_end_samples(
    panel,
    *,
    sequence_length=60,
    minimum_bars_per_day=40,
    take_profit_pct=0.01,
    stop_loss_pct=0.006,
):
    """Create one sample per day using next-day-only barrier outcomes."""
    if not isinstance(sequence_length, int) or sequence_length < 2:
        raise ValueError("sequence_length 必须至少为 2")
    if not isinstance(minimum_bars_per_day, int) or minimum_bars_per_day < 1:
        raise ValueError("minimum_bars_per_day 必须为正整数")

    times, arrays = _panel_arrays(panel)
    features = _minute_features_from_arrays(times, arrays)
    groups = _session_groups(times)
    rows = {
        "X": [],
        "dates": [],
        "y_barrier": [],
        "entry_open": [],
        "entry_date": [],
    }
    for day_index in range(len(groups) - 1):
        signal_date, signal_indices = groups[day_index]
        entry_date, entry_indices = groups[day_index + 1]
        signal_index = int(signal_indices[-1])
        if (
            len(signal_indices) < minimum_bars_per_day
            or len(entry_indices) < minimum_bars_per_day
            or not times[signal_index].endswith("15:00:00")
        ):
            continue
        sequence_start = signal_index - sequence_length + 1
        if sequence_start < 0:
            continue

        entry = float(arrays["open"][entry_indices[0]])
        barrier = triple_barrier_outcome(
            entry_price=entry,
            future_high=arrays["high"][entry_indices],
            future_low=arrays["low"][entry_indices],
            take_profit_pct=take_profit_pct,
            stop_loss_pct=stop_loss_pct,
        )
        rows["X"].append(features[sequence_start:signal_index + 1])
        rows["dates"].append(signal_date)
        rows["y_barrier"].append(barrier)
        rows["entry_open"].append(entry)
        rows["entry_date"].append(entry_date)

    return {
        "X": np.asarray(rows["X"], dtype=np.float32).reshape(
            (-1, sequence_length, len(FEATURE_NAMES))
        ),
        "dates": np.asarray(rows["dates"]),
        "y_barrier": np.asarray(rows["y_barrier"], dtype=np.int8),
        "entry_open": np.asarray(rows["entry_open"], dtype=np.float32),
        "entry_date": np.asarray(rows["entry_date"]),
        "feature_names": np.asarray(FEATURE_NAMES),
    }


def _load_cache_panel(path):
    """Load and validate cache columns without materializing Python row dicts."""
    try:
        with np.load(path, allow_pickle=False) as data:
            metadata = json.loads(str(data["metadata"].item()))
            frequency = metadata["frequency"]
            code = metadata["code"]
            start = datetime.strptime(metadata["start"], _TIME_FORMAT)
            end = datetime.strptime(metadata["end"], _TIME_FORMAT)
            fields = ("trade_time", "open", "high", "low", "close", "vol", "amount")
            if any(field not in data.files for field in fields):
                raise ValueError("分钟缓存缺少字段")
            panel = {
                "trade_time": np.array(data["trade_time"], dtype="U19", copy=True),
                **{
                    field: np.array(data[field], dtype=float, copy=True)
                    for field in fields[1:]
                },
            }
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError(f"分钟缓存元数据损坏: {path}") from error
    if frequency != "5min":
        raise ValueError(f"分钟缓存频率不是 5min: {path}")
    expected = {
        "version": 1,
        "frequency": frequency,
        "code": code,
        "start": start.strftime(_TIME_FORMAT),
        "end": end.strftime(_TIME_FORMAT),
        "fields": [
            "ts_code",
            "trade_time",
            "open",
            "close",
            "high",
            "low",
            "vol",
            "amount",
        ],
    }
    if any(metadata.get(key) != value for key, value in expected.items()):
        raise ValueError(f"分钟缓存元数据不一致: {path}")
    size = len(panel["trade_time"])
    if metadata.get("rows") != size:
        raise ValueError(f"分钟缓存行数不一致: {path}")
    if any(len(values) != size for values in panel.values()):
        raise ValueError(f"分钟缓存列长度不一致: {path}")
    if not size:
        return code, panel
    numeric = ("open", "high", "low", "close", "vol", "amount")
    if any(not np.isfinite(panel[field]).all() for field in numeric):
        raise ValueError(f"分钟缓存存在非有限数值: {path}")
    if (
        np.any(panel["open"] <= 0)
        or np.any(panel["close"] <= 0)
        or np.any(panel["low"] <= 0)
    ):
        raise ValueError(f"分钟缓存 OHLC 非正数: {path}")
    if np.any(panel["high"] < np.maximum(panel["open"], panel["close"])):
        raise ValueError(f"分钟缓存 high 无效: {path}")
    if np.any(panel["low"] > np.minimum(panel["open"], panel["close"])):
        raise ValueError(f"分钟缓存 low 无效: {path}")
    if np.any(panel["vol"] < 0) or np.any(panel["amount"] < 0):
        raise ValueError(f"分钟缓存成交量或成交额无效: {path}")
    if np.any(panel["trade_time"][1:] <= panel["trade_time"][:-1]):
        raise ValueError(f"分钟缓存时间未严格升序: {path}")
    return code, panel


def build_dataset_from_cache(
    cache_root,
    *,
    sequence_length=60,
    minimum_bars_per_day=40,
    take_profit_pct=0.01,
    stop_loss_pct=0.006,
):
    """Merge validated 5-minute cache slices into a cross-sectional dataset."""
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
    for code, panels in sorted(panels_by_code.items()):
        panel = {
            field: np.concatenate([current[field] for current in panels])
            for field in ("trade_time", "open", "high", "low", "close", "vol", "amount")
        }
        if not len(panel["trade_time"]):
            continue
        samples = make_day_end_samples(
            panel,
            sequence_length=sequence_length,
            minimum_bars_per_day=minimum_bars_per_day,
            take_profit_pct=take_profit_pct,
            stop_loss_pct=stop_loss_pct,
        )
        if not len(samples["dates"]):
            continue
        samples["codes"] = np.full(len(samples["dates"]), code)
        chunks.append(samples)
    if not chunks:
        raise RuntimeError("分钟缓存未生成任何 T+1 样本")

    fields = ("X", "dates", "y_barrier", "entry_open", "entry_date", "codes")
    dataset = {
        field: np.concatenate([chunk[field] for chunk in chunks])
        for field in fields
    }
    dataset["feature_names"] = np.asarray(FEATURE_NAMES)
    return dataset


def barrier_counts(labels):
    """Return JSON-serializable class counts for the barrier labels."""
    values, counts = np.unique(np.asarray(labels), return_counts=True)
    return {
        int(label): int(count)
        for label, count in zip(values, counts)
    }


def main():
    parser = argparse.ArgumentParser(
        description="从验证后的 5 分钟缓存构建 T+1 时序训练集",
    )
    parser.add_argument("--cache-root", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--sequence-length", type=int, default=60)
    parser.add_argument("--minimum-bars-per-day", type=int, default=40)
    parser.add_argument("--take-profit-pct", type=float, default=0.01)
    parser.add_argument("--stop-loss-pct", type=float, default=0.006)
    args = parser.parse_args()

    dataset = build_dataset_from_cache(
        args.cache_root,
        sequence_length=args.sequence_length,
        minimum_bars_per_day=args.minimum_bars_per_day,
        take_profit_pct=args.take_profit_pct,
        stop_loss_pct=args.stop_loss_pct,
    )
    output = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    np.savez_compressed(
        output,
        **dataset,
        created_at=np.asarray([int(time.time())], dtype=np.int64),
        target_rule=np.asarray(
            [
                "T+1 next-day triple barrier: "
                "entry=next_open,tp=1.0%,sl=0.6%"
            ]
        ),
    )
    counts = barrier_counts(dataset["y_barrier"])
    print(
        json.dumps(
            {
                "out": output,
                "samples": int(len(dataset["dates"])),
                "codes": int(len(np.unique(dataset["codes"]))),
                "sequence_shape": list(dataset["X"].shape),
                "barrier_counts": counts,
            },
            ensure_ascii=False,
        )
    )
    print("INTRADAY_DATASET_BUILD_OK")


if __name__ == "__main__":
    main()
