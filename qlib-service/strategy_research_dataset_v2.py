"""Build dual-price, point-in-time research datasets for StrategySpec v2."""

import argparse
import gzip
import hashlib
import json
import math
import os
from datetime import datetime, timezone

import numpy as np


SCHEMA_VERSION = "strategy-dataset.v2"
GENERATOR_VERSION = "strategy-research-dataset.v2"
REQUIRED_ARRAYS = (
    "dates",
    "o",
    "h",
    "l",
    "c",
    "qfq_o",
    "qfq_h",
    "qfq_l",
    "qfq_c",
    "v",
    "amount",
    "adj_factor",
    "is_st",
    "is_suspended",
    "listing_days",
    "bar_complete",
)
TECHNICAL_FIELDS = {
    "f_atr_pct": "atrPct",
    "f_atr_stop_broken": "atrStopBroken",
    "f_boll_pct": "bollPct",
    "f_donchian_breakout": "donchianBreakout",
    "f_ma_slope20": "maSlope20",
    "f_rsi6": "rsi6",
    "f_structure_break": "structureBreak",
    "f_vwap_deviation_pct": "vwapDeviationPct",
}


def _finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _bool(value):
    if isinstance(value, np.bool_):
        return bool(value)
    return value if isinstance(value, bool) else None


def _metadata(panel, key, default=""):
    value = panel.get(key, default)
    if isinstance(value, np.ndarray):
        if value.size != 1:
            raise ValueError("%s metadata must be scalar" % key)
        value = value.reshape(-1)[0]
    return str(value)


def _array_value(panel, key, index):
    values = panel.get(key)
    if values is None or index >= len(values):
        return None
    return values[index]


def _price_stream(panel, prefix, index, adjustment):
    values = {}
    for field in ("o", "h", "l", "c"):
        source = "%s%s" % (prefix, field)
        value = _finite(_array_value(panel, source, index))
        if value is None or value <= 0:
            return None
        values[{
            "o": "open",
            "h": "high",
            "l": "low",
            "c": "close",
        }[field]] = value
    values["adjustment"] = adjustment
    return values


def _amount_yuan(panel, index):
    amount = _finite(_array_value(panel, "amount", index))
    if amount is None:
        return None
    unit = _metadata(panel, "amount_unit", "THOUSAND_CNY").upper()
    if unit == "CNY":
        return amount
    if unit == "THOUSAND_CNY":
        return amount * 1000.0
    raise ValueError("unsupported amount_unit: %s" % unit)


def _volume_shares(panel, index):
    volume = _finite(_array_value(panel, "v", index))
    if volume is None:
        return None
    unit = _metadata(panel, "volume_unit", "SHARES").upper()
    if unit == "SHARES":
        return volume
    if unit == "HANDS":
        return volume * 100.0
    raise ValueError("unsupported volume_unit: %s" % unit)


def _average_amount(panel, index, window=20):
    values = [
        _amount_yuan(panel, cursor)
        for cursor in range(max(0, index - window + 1), index + 1)
    ]
    values = [value for value in values if value is not None and value > 0]
    return sum(values) / len(values) if values else None


def _technical(panel, index):
    output = {}
    for source, target in TECHNICAL_FIELDS.items():
        raw = _array_value(panel, source, index)
        if raw is None:
            continue
        if target in ("atrStopBroken", "donchianBreakout", "structureBreak"):
            value = _bool(raw)
        else:
            value = _finite(raw)
        if value is not None:
            output[target] = value
    return output


def _canonical_hash(payload):
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _normalise_code(value):
    return str(value).strip().upper()


def _build_bar(code, panel, index, prediction, timeframe):
    timestamp = str(panel["dates"][index]).replace("-", "").replace(":", "")
    raw = _price_stream(panel, "", index, "RAW")
    signal = _price_stream(panel, "qfq_", index, "QFQ")
    previous_close = _finite(_array_value(panel, "c", index - 1))
    volume = _volume_shares(panel, index)
    amount = _amount_yuan(panel, index)
    adjustment_factor = _finite(_array_value(panel, "adj_factor", index))
    is_st = _bool(_array_value(panel, "is_st", index))
    is_suspended = _bool(_array_value(panel, "is_suspended", index))
    listing_days = _finite(_array_value(panel, "listing_days", index))
    bar_closed = _bool(_array_value(panel, "bar_complete", index))
    required = {
        "rawPrice": raw,
        "signalPrice": signal,
        "previousClose": previous_close,
        "volume": volume,
        "amount": amount,
        "adj_factor": adjustment_factor,
        "is_st": is_st,
        "is_suspended": is_suspended,
        "listing_days": listing_days,
        "bar_complete": bar_closed,
    }
    missing = [key for key, value in required.items() if value is None]
    if timeframe == "5m" and bar_closed is not True:
        missing.append("incompleteBar")
    if missing:
        return None, missing
    if (
        previous_close <= 0
        or volume < 0
        or amount <= 0
        or adjustment_factor <= 0
        or listing_days < 0
    ):
        return None, ["invalidMarketData"]

    quant_score = _finite(prediction.get("quantScore"))
    if quant_score is None:
        return None, ["quantScore"]
    pct = (raw["close"] / previous_close - 1.0) * 100.0
    date = timestamp[:8]
    return {
        "timestamp": timestamp,
        "date": date,
        "timeframe": timeframe,
        "barClosed": bar_closed,
        "code": code,
        "name": _metadata(panel, "name", code),
        "industry": _metadata(panel, "industry", "UNKNOWN"),
        "signalPrice": signal,
        "executionPrice": {
            **raw,
            "previousClose": previous_close,
        },
        "adjustmentFactor": adjustment_factor,
        "volume": volume,
        "amount": amount,
        "adv20": _average_amount(panel, index),
        "listingDays": int(listing_days),
        "isSt": is_st,
        "isSuspended": is_suspended,
        "marketRegime": _metadata(panel, "market_regime", "UNKNOWN"),
        "marketScore": _finite(
            _array_value(panel, "market_score", index)
        ),
        "pct": round(pct, 6),
        "volRatio": _finite(_array_value(panel, "volume_ratio", index)),
        "relativeStrength20": _finite(
            _array_value(panel, "f_relative_strength20", index)
        ),
        "sector": {
            "breadth": _finite(
                _array_value(panel, "f_sector_breadth", index)
            ),
        },
        "technical": _technical(panel, index),
        "quant": {
            "score": quant_score,
            "upProb": _finite(prediction.get("upProb")),
            "expRet": _finite(prediction.get("expRet")),
            "highConfFired": prediction.get("highConfFired") is True,
        },
        "evidenceSources": {
            "signalPrice": "POINT_IN_TIME_QFQ",
            "executionPrice": "POINT_IN_TIME_RAW",
            "adjustmentFactor": "POINT_IN_TIME_ADJ_FACTOR",
            "historicalStatus": "POINT_IN_TIME_SECURITY_STATUS",
            "quant.score": prediction.get("scoreSource"),
        },
    }, []


def build_strategy_dataset_v2(
    panels,
    predictions,
    *,
    timeframe,
    minimum_history=20,
    minimum_coverage=0.95,
    source_metadata=None,
    generated_at=None,
):
    if timeframe not in ("1d", "5m"):
        raise ValueError("timeframe must be 1d or 5m")
    if not isinstance(panels, dict):
        raise ValueError("panels must be a code-to-panel mapping")
    if not 0 < float(minimum_coverage) <= 1:
        raise ValueError("minimum_coverage must be in (0, 1]")

    bars = []
    matched = set()
    missing_fields = set()
    rejected = 0
    for raw_code, panel in sorted(panels.items()):
        code = _normalise_code(raw_code)
        panel_timeframe = _metadata(panel, "timeframe", timeframe)
        if panel_timeframe != timeframe:
            missing_fields.add("timeframeMismatch")
            continue
        absent = [key for key in REQUIRED_ARRAYS if key not in panel]
        if absent:
            missing_fields.update(absent)
            dates = panel.get("dates", [])
            for timestamp in dates:
                key = (str(timestamp).replace("-", "").replace(":", ""), code)
                if key in predictions:
                    matched.add(key)
                    rejected += 1
            continue
        lengths = [len(np.asarray(panel[key])) for key in REQUIRED_ARRAYS]
        if len(set(lengths)) != 1:
            raise ValueError("panel arrays must have equal length for %s" % code)
        for index in range(max(1, int(minimum_history) - 1), lengths[0]):
            timestamp = str(panel["dates"][index]).replace("-", "").replace(":", "")
            key = (timestamp, code)
            prediction = predictions.get(key)
            if prediction is None:
                continue
            matched.add(key)
            bar, missing = _build_bar(
                code,
                panel,
                index,
                prediction,
                timeframe,
            )
            if bar is None:
                missing_fields.update(missing)
                rejected += 1
                continue
            bars.append(bar)

    bars.sort(key=lambda item: (item["timestamp"], item["code"]))
    prediction_count = len(predictions)
    coverage = len(bars) / prediction_count if prediction_count else 0.0
    unmatched = len(set(predictions) - matched)
    usable = (
        bool(bars)
        and coverage >= float(minimum_coverage)
        and not missing_fields
    )
    sources = {
        "provider": str((source_metadata or {}).get("provider") or "UNKNOWN"),
        "datasetVersion": str(
            (source_metadata or {}).get("datasetVersion") or "UNKNOWN"
        ),
    }
    generated = generated_at or datetime.now(timezone.utc).isoformat()
    quality = {
        "usable": usable,
        "predictionCount": prediction_count,
        "barCount": len(bars),
        "coverage": round(coverage, 6),
        "missingRate": round(1.0 - coverage, 6),
        "unmatchedPredictions": unmatched,
        "rejectedMatchedRows": rejected,
        "missingRequiredFields": sorted(missing_fields),
        "futureFieldsUsed": [],
    }
    manifest_payload = {
        "timeframe": timeframe,
        "bars": bars,
        "source": sources,
    }
    dates = sorted({item["date"] for item in bars})
    manifest = {
        "schemaVersion": "strategy-dataset-manifest.v2",
        "generatorVersion": GENERATOR_VERSION,
        "generatedAt": generated,
        "source": sources,
        "timeframe": timeframe,
        "startDate": dates[0] if dates else None,
        "endDate": dates[-1] if dates else None,
        "stockCount": len({item["code"] for item in bars}),
        "rowCount": len(bars),
        "coverage": quality["coverage"],
        "missingRate": quality["missingRate"],
        "priceStreams": {"signal": "QFQ", "execution": "RAW"},
        "contentSha256": _canonical_hash(manifest_payload),
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "manifest": manifest,
        "quality": quality,
        "bars": bars,
    }


def _load_panels(directory):
    panels = {}
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".npz") or name.startswith("_"):
            continue
        path = os.path.join(directory, name)
        with np.load(path, allow_pickle=False) as data:
            panels[name[:-4].replace("_", ".").upper()] = {
                key: data[key] for key in data.files
            }
    return panels


def _load_predictions(path, score_key):
    with np.load(path, allow_pickle=False) as data:
        dates = data["dates"].astype(str)
        codes = data["codes"].astype(str)
        scores = np.asarray(data[score_key], dtype=float)
    return {
        (
            str(timestamp).replace("-", "").replace(":", ""),
            _normalise_code(code),
        ): {
            "quantScore": float(score) * 100 if 0 <= score <= 1 else float(score),
            "scoreSource": "oos:%s" % os.path.basename(path),
        }
        for timestamp, code, score in zip(dates, codes, scores)
        if math.isfinite(float(score))
    }


def _write_json(path, payload):
    output = os.path.abspath(path)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    opener = gzip.open if output.endswith(".gz") else open
    temporary = "%s.tmp.%d" % (output, os.getpid())
    try:
        with opener(temporary, "wt", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--panel", required=True)
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--score-key", required=True)
    parser.add_argument("--timeframe", choices=("1d", "5m"), required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--minimum-history", type=int, default=20)
    parser.add_argument("--minimum-coverage", type=float, default=0.95)
    parser.add_argument("--provider", default="TUSHARE")
    parser.add_argument("--dataset-version", required=True)
    args = parser.parse_args(argv)
    dataset = build_strategy_dataset_v2(
        _load_panels(args.panel),
        _load_predictions(args.predictions, args.score_key),
        timeframe=args.timeframe,
        minimum_history=args.minimum_history,
        minimum_coverage=args.minimum_coverage,
        source_metadata={
            "provider": args.provider,
            "datasetVersion": args.dataset_version,
        },
    )
    _write_json(args.out, dataset)
    print(json.dumps(dataset["quality"], ensure_ascii=False, indent=2))
    if not dataset["quality"]["usable"]:
        print("STRATEGY_DATASET_V2_QUALITY_GATE_FAILED")
        return 2
    print("STRATEGY_DATASET_V2_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
