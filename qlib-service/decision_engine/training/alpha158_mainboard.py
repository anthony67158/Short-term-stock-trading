"""Build and evaluate a main-board Alpha158 LightGBM rank signal."""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import time
import warnings
from collections import defaultdict

import lightgbm as lgb
import numpy as np

from .alpha158_features import FEATURE_NAMES, alpha158_matrix


PANEL_SCHEMA_VERSION = "mainboard-alpha158-panel.v1"
RESULT_SCHEMA_VERSION = "mainboard-alpha158-walkforward.v1"
MAIN_BOARD_PREFIXES = (
    "000",
    "001",
    "002",
    "003",
    "600",
    "601",
    "603",
    "605",
)


def _finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _stable_hash(value):
    result = 2166136261
    for character in str(value):
        result ^= ord(character)
        result = (result * 16777619) & 0xFFFFFFFF
    return result


def _main_board(code):
    return str(code or "")[:3] in MAIN_BOARD_PREFIXES


def _eligible(row):
    name = str(row.get("name") or "")
    return (
        _main_board(row.get("code"))
        and not bool(row.get("isSt") or row.get("is_st"))
        and "ST" not in name.upper()
        and "退" not in name
        and (_finite(row.get("close")) or 0) > 0
        and (
            _finite(row.get("selectionAmount") or row.get("amount"))
            or 0
        ) >= 30_000_000
        and (
            _finite(row.get("turnover") or row.get("turnover_rate"))
            or 0
        ) >= 0.3
    )


def select_causal_universe(rows, trade_date, limit=1000):
    candidates = [row for row in rows if _eligible(row)]
    liquid_limit = max(1, min(limit, int(limit * 0.8)))
    liquid = sorted(
        candidates,
        key=lambda row: (
            -float(row.get("selectionAmount") or row.get("amount") or 0),
            str(row.get("code") or ""),
        ),
    )[:liquid_limit]
    selected = {str(row["code"]) for row in liquid}
    exploration = sorted(
        (
            row for row in candidates
            if str(row["code"]) not in selected
        ),
        key=lambda row: (
            _stable_hash(f"{trade_date}:{row['code']}"),
            str(row["code"]),
        ),
    )
    for row in exploration:
        if len(selected) >= limit:
            break
        selected.add(str(row["code"]))
    return tuple(sorted(selected))


def _load_daily(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        source = json.load(handle)
    if not isinstance(source, list):
        raise ValueError("Alpha158 daily rows must be a list")
    rows = []
    for index, value in enumerate(source):
        source[index] = None
        code = str(value.get("code") or "")
        date = str(value.get("date") or "").replace("-", "")
        if not _main_board(code) or len(date) != 8:
            continue
        rows.append({
            "date": date,
            "code": code,
            "name": str(value.get("name") or code),
            "open": _finite(value.get("open")),
            "high": _finite(value.get("high")),
            "low": _finite(value.get("low")),
            "close": _finite(value.get("close")),
            "preClose": _finite(
                value.get("preClose") or value.get("pre_close")
            ),
            "volume": _finite(value.get("volume") or value.get("vol")),
            "amount": _finite(value.get("amount") or value.get("money")),
            "selectionAmount": _finite(
                value.get("amount") or value.get("money")
            ),
            "turnover": _finite(
                value.get("turnover") or value.get("turnover_rate")
            ),
            "isSt": bool(value.get("isSt") or value.get("is_st")),
        })
    del source
    by_code = defaultdict(list)
    for row in rows:
        by_code[row["code"]].append(row)
    adjusted = []
    for code_rows in by_code.values():
        code_rows.sort(key=lambda row: row["date"])
        previous_adjusted_close = None
        previous_raw_close = None
        for row in code_rows:
            raw_close = row["close"]
            reference = row["preClose"] or previous_raw_close
            scale = (
                previous_adjusted_close / reference
                if (
                    previous_adjusted_close is not None
                    and reference is not None
                    and reference > 0
                )
                else 1.0
            )
            for name in ("open", "high", "low", "close", "amount"):
                value = row[name]
                row[name] = value * scale if value is not None else None
            row["preClose"] = (
                previous_adjusted_close
                if previous_adjusted_close is not None
                else row["preClose"]
            )
            previous_adjusted_close = row["close"]
            previous_raw_close = raw_close
            adjusted.append(row)
    return adjusted


def _date_zscore(values, dates):
    result = np.full(len(values), np.nan, dtype=np.float32)
    for date in np.unique(dates):
        selected = np.flatnonzero(dates == date)
        current = np.asarray(values[selected], dtype=np.float64)
        valid = np.isfinite(current)
        if valid.sum() < 2:
            continue
        mean = current[valid].mean()
        std = current[valid].std()
        if std <= 1e-12:
            result[selected[valid]] = 0.0
        else:
            result[selected[valid]] = (
                (current[valid] - mean) / std
            ).astype(np.float32)
    return result


def build_panel(
    daily_path,
    *,
    start_date=None,
    end_date=None,
    universe_size=1000,
):
    rows = _load_daily(daily_path)
    dates = sorted({row["date"] for row in rows})
    if not dates:
        raise ValueError("Alpha158 daily rows are empty")
    date_index = {date: index for index, date in enumerate(dates)}
    effective_start = start_date or dates[0]
    effective_end = end_date or dates[-1]
    signal_dates = [
        date for date in dates
        if effective_start <= date <= effective_end
    ]
    if len(signal_dates) < 40:
        raise ValueError("Alpha158 signal dates are insufficient")
    rows_by_date = defaultdict(list)
    rows_by_code = defaultdict(dict)
    for row in rows:
        rows_by_date[row["date"]].append(row)
        rows_by_code[row["code"]][row["date"]] = row

    universes = {}
    for date in signal_dates:
        index = date_index[date]
        if index <= 0:
            continue
        previous = dates[index - 1]
        universes[date] = select_causal_universe(
            rows_by_date[previous],
            date,
            universe_size,
        )
    selected_by_code = defaultdict(set)
    for date, codes in universes.items():
        for code in codes:
            selected_by_code[code].add(date)

    features = []
    labels = []
    sample_dates = []
    label_end_dates = []
    codes = []
    latest_features = []
    latest_codes = []
    latest_signal_date = signal_dates[-1]
    for code_index, (code, selected_dates) in enumerate(
        sorted(selected_by_code.items()),
        start=1,
    ):
        source = rows_by_code[code]
        shape = len(dates)
        arrays = {
            name: np.full(shape, np.nan, dtype=np.float64)
            for name in (
                "open",
                "high",
                "low",
                "close",
                "volume",
                "amount",
            )
        }
        for date, row in source.items():
            index = date_index[date]
            for name in arrays:
                value = _finite(row.get(name))
                if value is not None:
                    arrays[name][index] = value
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            matrix = alpha158_matrix(
                arrays["open"],
                arrays["high"],
                arrays["low"],
                arrays["close"],
                arrays["volume"],
                arrays["amount"],
            )
        for date in sorted(selected_dates):
            index = date_index[date]
            if index < 60:
                continue
            if date == latest_signal_date:
                latest_features.append(matrix[index])
                latest_codes.append(code)
            if index + 2 >= len(dates):
                continue
            label_end = dates[index + 2]
            next_close = arrays["close"][index + 1]
            end_close = arrays["close"][index + 2]
            if (
                not np.isfinite(arrays["close"][index])
                or not np.isfinite(next_close)
                or not np.isfinite(end_close)
                or next_close <= 0
            ):
                continue
            features.append(matrix[index])
            labels.append(end_close / next_close - 1.0)
            sample_dates.append(date)
            label_end_dates.append(label_end)
            codes.append(code)
        if code_index % 250 == 0:
            print(json.dumps({
                "stage": "FEATURES",
                "codes": code_index,
                "samples": len(features),
            }))

    X = np.asarray(features, dtype=np.float32)
    raw_labels = np.asarray(labels, dtype=np.float32)
    date_values = np.asarray(sample_dates, dtype="<U8")
    z_labels = _date_zscore(raw_labels, date_values)
    valid = np.isfinite(z_labels)
    return {
        "schema_version": PANEL_SCHEMA_VERSION,
        "X": X[valid],
        "y": z_labels[valid],
        "y_raw": raw_labels[valid],
        "dates": date_values[valid],
        "label_end_dates": np.asarray(
            label_end_dates,
            dtype="<U8",
        )[valid],
        "codes": np.asarray(codes, dtype="<U6")[valid],
        "feature_names": np.asarray(FEATURE_NAMES, dtype="<U16"),
        "signal_dates": np.asarray(signal_dates, dtype="<U8"),
        "latest_X": np.asarray(
            latest_features,
            dtype=np.float32,
        ).reshape((-1, len(FEATURE_NAMES))),
        "latest_codes": np.asarray(latest_codes, dtype="<U6"),
        "latest_date": np.asarray(latest_signal_date, dtype="<U8"),
        "summary": {
            "dailyRows": len(rows),
            "codes": len(rows_by_code),
            "signalDates": len(signal_dates),
            "samples": int(valid.sum()),
            "featureCount": len(FEATURE_NAMES),
            "universeSize": universe_size,
        },
    }


def save_panel(path, panel):
    payload = {
        key: value
        for key, value in panel.items()
        if key != "summary"
    }
    payload["summary_json"] = json.dumps(
        panel["summary"],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    np.savez_compressed(path, **payload)


def load_panel(path):
    source = np.load(path, allow_pickle=False)
    return {
        key: source[key]
        for key in source.files
        if key != "summary_json"
    } | {
        "summary": json.loads(str(source["summary_json"])),
    }


def _spearman(left, right):
    left_order = np.argsort(left, kind="stable")
    right_order = np.argsort(right, kind="stable")
    left_rank = np.empty(len(left), dtype=np.float64)
    right_rank = np.empty(len(right), dtype=np.float64)
    left_rank[left_order] = np.arange(len(left), dtype=np.float64)
    right_rank[right_order] = np.arange(len(right), dtype=np.float64)
    if left_rank.std() <= 1e-12 or right_rank.std() <= 1e-12:
        return np.nan
    return float(np.corrcoef(left_rank, right_rank)[0, 1])


def _signal_metrics(scores, labels, dates):
    ic = []
    rank_ic = []
    for date in np.unique(dates):
        selected = np.flatnonzero(dates == date)
        if len(selected) < 5:
            continue
        left = scores[selected]
        right = labels[selected]
        if left.std() > 1e-12 and right.std() > 1e-12:
            ic.append(float(np.corrcoef(left, right)[0, 1]))
            rank_ic.append(_spearman(left, right))
    return {
        "days": len(ic),
        "IC": round(float(np.mean(ic)), 6) if ic else None,
        "RankIC": (
            round(float(np.nanmean(rank_ic)), 6)
            if rank_ic else None
        ),
        "ICIR": (
            round(float(np.mean(ic) / np.std(ic)), 6)
            if len(ic) > 1 and np.std(ic) > 1e-12 else None
        ),
    }


def _cross_section_percentiles(scores):
    values = np.asarray(scores, dtype=np.float64)
    if len(values) == 1:
        return np.asarray([0.5], dtype=np.float64)
    order = np.argsort(values, kind="stable")
    ranks = np.empty(len(values), dtype=np.float64)
    ranks[order] = np.arange(len(values), dtype=np.float64)
    return ranks / max(1, len(values) - 1)


def _folds(panel, splits=3):
    dates = np.unique(panel["dates"])
    blocks = np.array_split(dates, splits + 1)
    output = []
    for validation_dates in blocks[1:]:
        validation_start = validation_dates[0]
        outer_dates = dates[dates < validation_start]
        calibration_count = max(1, math.ceil(len(outer_dates) * 0.15))
        calibration_dates = outer_dates[-calibration_count:]
        calibration_start = calibration_dates[0]
        train = np.flatnonzero(
            (panel["dates"] < calibration_start)
            & (panel["label_end_dates"] < calibration_start)
        )
        calibration = np.flatnonzero(
            np.isin(panel["dates"], calibration_dates)
            & (panel["label_end_dates"] < validation_start)
        )
        validation = np.flatnonzero(
            np.isin(panel["dates"], validation_dates)
        )
        if not len(train) or not len(calibration) or not len(validation):
            raise ValueError("Alpha158 fold is empty")
        output.append({
            "train": train,
            "calibration": calibration,
            "validation": validation,
            "metadata": {
                "trainStartDate": min(
                    panel["dates"][train].astype(str).tolist()
                ),
                "trainEndDate": max(
                    panel["dates"][train].astype(str).tolist()
                ),
                "calibrationStartDate":
                    min(panel["dates"][calibration].astype(str).tolist()),
                "calibrationEndDate":
                    max(panel["dates"][calibration].astype(str).tolist()),
                "validationStartDate":
                    str(validation_dates[0]),
                "validationEndDate":
                    str(validation_dates[-1]),
                "trainSamples": int(len(train)),
                "calibrationSamples": int(len(calibration)),
                "validationSamples": int(len(validation)),
            },
        })
    return output


def _fit_model(panel, fold, threads):
    parameters = {
        "objective": "mse",
        "verbosity": -1,
        "colsample_bytree": 0.8879,
        "learning_rate": 0.2,
        "subsample": 0.8789,
        "lambda_l1": 205.6999,
        "lambda_l2": 580.9768,
        "max_depth": 8,
        "num_leaves": 210,
        "num_threads": threads,
        "seed": 42,
        "feature_fraction_seed": 42,
        "bagging_seed": 42,
    }
    train = lgb.Dataset(
        panel["X"][fold["train"]],
        label=panel["y"][fold["train"]],
        free_raw_data=False,
    )
    calibration = lgb.Dataset(
        panel["X"][fold["calibration"]],
        label=panel["y"][fold["calibration"]],
        reference=train,
        free_raw_data=False,
    )
    return lgb.train(
        parameters,
        train,
        num_boost_round=1000,
        valid_sets=[train, calibration],
        valid_names=["train", "valid"],
        callbacks=[
            lgb.early_stopping(50, verbose=False),
            lgb.log_evaluation(period=0),
        ],
    )


def _latest_ranking(panel, *, threads, top_n):
    latest_date = str(panel["latest_date"])
    latest_matrix = np.asarray(panel["latest_X"], dtype=np.float32)
    latest_codes = np.asarray(panel["latest_codes"]).astype(str)
    if not len(latest_matrix) or len(latest_matrix) != len(latest_codes):
        raise ValueError("Alpha158 latest inference rows are missing")
    dates = np.unique(panel["dates"])
    mature_dates = dates[dates < latest_date]
    if len(mature_dates) < 30:
        raise ValueError("Alpha158 final training dates are insufficient")
    calibration_count = max(5, math.ceil(len(mature_dates) * 0.15))
    calibration_dates = mature_dates[-calibration_count:]
    calibration_start = calibration_dates[0]
    train = np.flatnonzero(
        (panel["dates"] < calibration_start)
        & (panel["label_end_dates"] < calibration_start)
    )
    calibration = np.flatnonzero(
        np.isin(panel["dates"], calibration_dates)
        & (panel["label_end_dates"] < latest_date)
    )
    if not len(train) or not len(calibration):
        raise ValueError("Alpha158 final fit partitions are empty")
    model = _fit_model(
        panel,
        {"train": train, "calibration": calibration},
        threads,
    )
    scores = np.asarray(
        model.predict(
            latest_matrix,
            num_iteration=model.best_iteration,
        ),
        dtype=np.float64,
    )
    latest_percentiles = _cross_section_percentiles(scores)
    signal_dates = np.asarray(panel["signal_dates"]).astype(str)
    previous_dates = signal_dates[signal_dates < latest_date]
    lag_date = (
        str(previous_dates[-5])
        if len(previous_dates) >= 5
        else None
    )
    lag_percentiles = {}
    if lag_date is not None:
        lag_indices = np.flatnonzero(panel["dates"] == lag_date)
        if len(lag_indices):
            lag_scores = np.asarray(
                model.predict(
                    panel["X"][lag_indices],
                    num_iteration=model.best_iteration,
                ),
                dtype=np.float64,
            )
            lag_pct = _cross_section_percentiles(lag_scores)
            lag_percentiles = {
                str(panel["codes"][row]): float(lag_pct[index])
                for index, row in enumerate(lag_indices)
            }
    order = np.lexsort((latest_codes, -scores))
    limit = min(len(order), max(1, int(top_n)))
    return {
        "date": latest_date,
        "trainEndDate": max(
            panel["dates"][train].astype(str).tolist()
        ),
        "calibrationEndDate": max(
            panel["dates"][calibration].astype(str).tolist()
        ),
        "trainSamples": int(len(train)),
        "calibrationSamples": int(len(calibration)),
        "bestIteration": int(model.best_iteration),
        "rankings": [
            {
                "date": latest_date,
                "code": str(latest_codes[index]),
                "rank": rank,
                "score": round(float(scores[index]), 8),
                "scoreMomentum5": (
                    round(
                        float(latest_percentiles[index])
                        - lag_percentiles[str(latest_codes[index])],
                        6,
                    )
                    if str(latest_codes[index]) in lag_percentiles
                    else None
                ),
            }
            for rank, index in enumerate(order[:limit], start=1)
        ],
    }


def run_walkforward(panel, *, threads=4, top_n=100):
    predictions = []
    reports = []
    all_scores = []
    all_labels = []
    all_dates = []
    for index, fold in enumerate(_folds(panel), start=1):
        started = time.time()
        model = _fit_model(panel, fold, threads)
        validation = fold["validation"]
        scores = np.asarray(
            model.predict(
                panel["X"][validation],
                num_iteration=model.best_iteration,
            ),
            dtype=np.float64,
        )
        metrics = _signal_metrics(
            scores,
            panel["y_raw"][validation],
            panel["dates"][validation],
        )
        all_scores.append(scores)
        all_labels.append(panel["y_raw"][validation])
        all_dates.append(panel["dates"][validation])
        dates = panel["dates"][validation]
        for date in np.unique(dates):
            selected = np.flatnonzero(dates == date)
            ranked = selected[
                np.argsort(-scores[selected], kind="stable")
            ][:top_n]
            for rank, local in enumerate(ranked, start=1):
                row = validation[local]
                predictions.append({
                    "fold": index,
                    "date": str(panel["dates"][row]),
                    "code": str(panel["codes"][row]),
                    "rank": rank,
                    "score": round(float(scores[local]), 8),
                    "label": round(float(panel["y_raw"][row]), 8),
                })
        reports.append({
            "fold": index,
            **fold["metadata"],
            "bestIteration": int(model.best_iteration),
            "elapsedSeconds": round(time.time() - started, 3),
            **metrics,
        })
        print(json.dumps({
            "stage": "FOLD_DONE",
            **reports[-1],
        }, ensure_ascii=False))
    overall = _signal_metrics(
        np.concatenate(all_scores),
        np.concatenate(all_labels),
        np.concatenate(all_dates),
    )
    return {
        "schemaVersion": RESULT_SCHEMA_VERSION,
        "generatedAt": int(time.time() * 1000),
        "source": panel["summary"],
        "featureNames": list(FEATURE_NAMES),
        "folds": reports,
        "overall": overall,
        "rankings": predictions,
        "latest": _latest_ranking(
            panel,
            threads=threads,
            top_n=top_n,
        ),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--daily", required=True)
    parser.add_argument("--panel", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--from", dest="start_date")
    parser.add_argument("--to", dest="end_date")
    parser.add_argument("--universe-size", type=int, default=1000)
    parser.add_argument("--top-n", type=int, default=100)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()

    if args.rebuild or not os.path.isfile(args.panel):
        panel = build_panel(
            args.daily,
            start_date=args.start_date,
            end_date=args.end_date,
            universe_size=args.universe_size,
        )
        save_panel(args.panel, panel)
    else:
        panel = load_panel(args.panel)
    result = run_walkforward(
        panel,
        threads=args.threads,
        top_n=max(1, min(args.universe_size, args.top_n)),
    )
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(
            result,
            handle,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
    print(json.dumps({
        "output": os.path.abspath(args.output),
        "overall": result["overall"],
        "folds": result["folds"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
