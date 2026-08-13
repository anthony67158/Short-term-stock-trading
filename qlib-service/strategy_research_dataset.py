"""Build point-in-time strategy-dataset.v1 records from research panels."""

import argparse
import gzip
import json
import math
import os

import numpy as np


REQUIRED_PANEL_FIELDS = (
    "dates",
    "o",
    "h",
    "l",
    "c",
    "v",
    "amount",
)


def _finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _clamp(value, lower=0.0, upper=1.0):
    return max(lower, min(upper, value))


def _peak(value, left, ideal, right):
    if value <= left or value >= right:
        return 0.0
    if value <= ideal:
        return (value - left) / (ideal - left)
    return (right - value) / (right - ideal)


def _normalise_code(value):
    return str(value).strip().upper()


def load_prediction_snapshot(path, *, score_key, source_id=None):
    """Load OOS predictions without exposing labels to strategy records."""
    with np.load(path, allow_pickle=True) as data:
        required = {"dates", "codes", score_key}
        missing = sorted(required - set(data.files))
        if missing:
            raise ValueError(
                "prediction snapshot missing keys: %s" % ", ".join(missing)
            )
        dates = data["dates"].astype(str)
        codes = data["codes"].astype(str)
        scores = np.asarray(data[score_key], dtype=float)
    if not (len(dates) == len(codes) == len(scores)):
        raise ValueError("prediction arrays must have equal length")
    if scores.ndim != 1:
        raise ValueError("prediction score must be one-dimensional")
    output = {}
    source = source_id or "oos:%s" % os.path.basename(path)
    for date, code, raw_score in zip(dates, codes, scores):
        key = (str(date).replace("-", ""), _normalise_code(code))
        if key in output:
            raise ValueError(
                "duplicate prediction for %s on %s" % (key[1], key[0])
            )
        score = _finite(raw_score)
        if score is None:
            continue
        quant_score = score * 100.0 if 0.0 <= score <= 1.0 else score
        output[key] = {
            "quantScore": _clamp(quant_score, 0.0, 100.0),
            "scoreSource": source,
        }
    return output


def load_panel_directory(panel_dir):
    panels = {}
    for name in sorted(os.listdir(panel_dir)):
        if not name.endswith(".npz") or name.startswith("_"):
            continue
        code = name[:-4].replace("_", ".").upper()
        path = os.path.join(panel_dir, name)
        with np.load(path, allow_pickle=True) as data:
            panels[code] = {key: data[key] for key in data.files}
    if not panels:
        raise ValueError("panel directory contains no stock NPZ files")
    return panels


def _array_value(panel, field, index):
    values = panel.get(field)
    if values is None or index >= len(values):
        return None
    return _finite(values[index])


def _derived_volume_ratio(panel, index):
    volume = _array_value(panel, "v", index)
    if volume is None or index <= 0:
        return None
    history = np.asarray(panel["v"][:index], dtype=float)
    history = history[np.isfinite(history) & (history > 0)]
    if not len(history):
        return None
    baseline = float(np.mean(history[-5:]))
    return volume / baseline if baseline > 0 else None


def _market_score(
    *,
    amount_yuan,
    pct,
    turnover,
    volume_ratio,
    main_inflow_yuan,
    main_ratio,
    speed=0.0,
    minimum_amount=8e7,
):
    inflow_yi = main_inflow_yuan / 1e8
    fund = max(
        _clamp((main_ratio + 3.0) / 18.0),
        _clamp(
            math.log10(max(inflow_yi, 0.0) + 1.0)
            / math.log10(8.0)
        ),
    )
    volume = _peak(volume_ratio, 0.5, 2.2, 8.0)
    momentum = _peak(pct, -3.0, 3.5, 8.8)
    speed_score = _clamp((speed + 0.2) / 1.6)
    liquidity = _clamp(
        math.log10(max(amount_yuan, 1.0) / minimum_amount)
        / math.log10(25.0)
    )
    turnover_score = _peak(turnover, 0.4, 6.0, 25.0)
    return _clamp(
        (
            fund * 0.30
            + volume * 0.15
            + momentum * 0.15
            + speed_score * 0.10
            + liquidity * 0.15
            + turnover_score * 0.15
        ) * 100.0,
        0.0,
        100.0,
    )


def _panel_amount_yuan(panel, index):
    value = _array_value(panel, "amount", index)
    if value is None:
        return None
    # Tushare daily.amount is thousand CNY. Explicit metadata can override it.
    unit = str(panel.get("amount_unit", "THOUSAND_CNY")).upper()
    if unit == "CNY":
        return value
    if unit == "THOUSAND_CNY":
        return value * 1000.0
    raise ValueError("unsupported panel amount_unit: %s" % unit)


def _panel_volume_shares(panel, index):
    value = _array_value(panel, "v", index)
    if value is None:
        return None
    unit = _metadata_text(panel, "volume_unit", "SHARES").upper()
    if unit == "SHARES":
        return value
    if unit == "HANDS":
        return value * 100.0
    raise ValueError("unsupported panel volume_unit: %s" % unit)


def _metadata_text(panel, key, default=""):
    value = panel.get(key, default)
    if isinstance(value, np.ndarray):
        if value.size != 1:
            raise ValueError("%s metadata must be scalar" % key)
        value = value.reshape(-1)[0]
    return str(value)


def _build_bar(code, panel, index, prediction):
    date = str(panel["dates"][index]).replace("-", "")
    previous_close = _array_value(panel, "c", index - 1)
    open_price = _array_value(panel, "o", index)
    high = _array_value(panel, "h", index)
    low = _array_value(panel, "l", index)
    close = _array_value(panel, "c", index)
    volume = _panel_volume_shares(panel, index)
    amount_yuan = _panel_amount_yuan(panel, index)
    required = {
        "previousClose": previous_close,
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
        "amount": amount_yuan,
    }
    missing = [key for key, value in required.items() if value is None]
    if missing:
        return None, missing
    if previous_close <= 0 or close <= 0 or volume < 0 or amount_yuan <= 0:
        return None, ["invalidMarketData"]

    pct = (close / previous_close - 1.0) * 100.0
    exact_volume_ratio = _array_value(panel, "b_volume_ratio", index)
    volume_ratio = exact_volume_ratio
    volume_source = "TUSHARE_DAILY_BASIC"
    if volume_ratio is None:
        volume_ratio = _derived_volume_ratio(panel, index)
        volume_source = "TRAILING_5D_VOLUME_PROXY"
    if volume_ratio is None:
        return None, ["volRatio"]

    turnover = _array_value(panel, "b_turnover_rate_f", index)
    turnover_source = "TUSHARE_DAILY_BASIC"
    if turnover is None:
        turnover = 0.0
        turnover_source = "MISSING_DEFAULT_ZERO"

    net_moneyflow = _array_value(panel, "m_net_mf_amount", index)
    moneyflow_source = "TUSHARE_MONEYFLOW"
    if net_moneyflow is None:
        main_inflow_yuan = 0.0
        main_ratio = 0.0
        moneyflow_source = "MISSING_DEFAULT_ZERO"
    else:
        main_inflow_yuan = net_moneyflow * 10_000.0
        main_ratio = main_inflow_yuan / amount_yuan * 100.0

    market_score = _market_score(
        amount_yuan=amount_yuan,
        pct=pct,
        turnover=turnover,
        volume_ratio=volume_ratio,
        main_inflow_yuan=main_inflow_yuan,
        main_ratio=main_ratio,
    )
    quant_score = float(prediction["quantScore"])
    return {
        "date": date,
        "code": code,
        "name": str(panel.get("name", code)),
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "previousClose": previous_close,
        "volume": volume,
        "amount": amount_yuan,
        "listingDays": index + 1,
        "marketScore": round(market_score, 6),
        "pct": round(pct, 6),
        "turnover": turnover,
        "volRatio": volume_ratio,
        "mainInflow": main_inflow_yuan,
        "mainRatio": main_ratio,
        "speed": 0.0,
        "quant": {
            "score": quant_score,
            "upProb": quant_score,
            "expRet": 0.0,
            "highConfFired": False,
        },
        "evidenceSources": {
            "ohlcv": "POINT_IN_TIME_PANEL",
            "amount": "POINT_IN_TIME_PANEL",
            "turnover": turnover_source,
            "volRatio": volume_source,
            "moneyflow": moneyflow_source,
            "speed": "UNAVAILABLE_DEFAULT_ZERO",
            "marketScore": "POINT_IN_TIME_DAILY_PROXY",
            "quant.score": "OOS_PREDICTION",
            "quant.source": prediction.get("scoreSource"),
        },
    }, []


def build_strategy_dataset(
    panels,
    predictions,
    *,
    minimum_history=20,
    minimum_coverage=0.95,
):
    if not isinstance(panels, dict):
        raise ValueError("panels must be a code-to-panel mapping")
    if not 0 < minimum_coverage <= 1:
        raise ValueError("minimum_coverage must be in (0, 1]")
    bars = []
    matched = set()
    rejected_matched_rows = 0
    missing_fields = set()
    source_counts = {}
    for raw_code, panel in sorted(panels.items()):
        code = _normalise_code(raw_code)
        if _metadata_text(
            panel,
            "price_adjustment",
            "UNKNOWN",
        ).upper() != "RAW":
            missing_fields.add("priceAdjustmentNotRaw")
            if "dates" in panel:
                for date in np.asarray(panel["dates"]).astype(str):
                    key = (str(date).replace("-", ""), code)
                    if key in predictions:
                        matched.add(key)
                        rejected_matched_rows += 1
            continue
        absent = [field for field in REQUIRED_PANEL_FIELDS if field not in panel]
        if absent:
            missing_fields.update(absent)
            if "dates" in panel:
                for date in np.asarray(panel["dates"]).astype(str):
                    key = (str(date).replace("-", ""), code)
                    if key in predictions:
                        matched.add(key)
                        rejected_matched_rows += 1
            continue
        dates = np.asarray(panel["dates"]).astype(str)
        lengths = [
            len(np.asarray(panel[field]))
            for field in REQUIRED_PANEL_FIELDS
        ]
        if len(set(lengths)) != 1:
            raise ValueError("panel arrays must have equal length for %s" % code)
        for index in range(max(1, int(minimum_history) - 1), len(dates)):
            key = (str(dates[index]).replace("-", ""), code)
            prediction = predictions.get(key)
            if prediction is None:
                continue
            matched.add(key)
            item, missing = _build_bar(code, panel, index, prediction)
            if item is None:
                missing_fields.update(missing)
                rejected_matched_rows += 1
                continue
            bars.append(item)
            for source in item["evidenceSources"].values():
                if source:
                    source_counts[source] = source_counts.get(source, 0) + 1

    bars.sort(key=lambda item: (item["date"], item["code"]))
    unmatched = len(set(predictions) - matched)
    coverage = len(bars) / len(predictions) if predictions else 0.0
    usable = bool(bars) and coverage >= minimum_coverage and not any(
        field in missing_fields
        for field in ("dates", "o", "h", "l", "c", "v", "amount")
    ) and "priceAdjustmentNotRaw" not in missing_fields
    return {
        "schemaVersion": "strategy-dataset.v1",
        "bars": bars,
        "quality": {
            "usable": usable,
            "predictionCount": len(predictions),
            "barCount": len(bars),
            "coverage": round(coverage, 6),
            "unmatchedPredictions": unmatched,
            "rejectedMatchedRows": rejected_matched_rows,
            "missingRequiredFields": sorted(missing_fields),
            "futureFieldsUsed": [],
            "sourceCounts": source_counts,
        },
    }


def _write_json(path, payload):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "wt", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--panel", required=True)
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--score-key", required=True)
    parser.add_argument("--source-id", default=None)
    parser.add_argument("--out", required=True)
    parser.add_argument("--minimum-history", type=int, default=20)
    parser.add_argument("--minimum-coverage", type=float, default=0.95)
    args = parser.parse_args(argv)
    predictions = load_prediction_snapshot(
        args.predictions,
        score_key=args.score_key,
        source_id=args.source_id,
    )
    dataset = build_strategy_dataset(
        load_panel_directory(args.panel),
        predictions,
        minimum_history=args.minimum_history,
        minimum_coverage=args.minimum_coverage,
    )
    _write_json(args.out, dataset)
    print(json.dumps(dataset["quality"], ensure_ascii=False, indent=2))
    if not dataset["quality"]["usable"]:
        print("STRATEGY_DATASET_QUALITY_GATE_FAILED")
        return 2
    print("STRATEGY_DATASET_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
