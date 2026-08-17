"""Forward-only accuracy report for the current production LightGBM model."""

import json
import time

import numpy as np


PRODUCTION_ACCURACY_KEY = "quantmodel/production_accuracy.json"
POSITIVE_THRESHOLD = 0.62
NEGATIVE_THRESHOLD = 0.38


def _date_key(value):
    return "".join(ch for ch in str(value or "") if ch.isdigit())[:8]


def _display_date(value):
    key = _date_key(value)
    return f"{key[:4]}-{key[4:6]}-{key[6:8]}" if len(key) == 8 else ""


def _pct(numerator, denominator):
    return round(float(numerator) / float(denominator) * 100, 1) if denominator else None


def _empty_metrics():
    return {
        "total": 0,
        "correct": 0,
        "accuracyPct": None,
        "balancedAccuracyPct": None,
    }


def _balanced_accuracy(labels, predictions):
    recalls = []
    for label in (0, 1):
        selected = labels == label
        if np.any(selected):
            recalls.append(float(np.mean(predictions[selected] == label)))
    if len(recalls) != 2:
        return None
    return round(float(np.mean(recalls)) * 100, 1)


def evaluate_production_model(
    booster,
    meta,
    *,
    X,
    labels,
    dates,
    codes,
    next_up_probabilities=None,
    next_actual_up=None,
    next_range_hit=None,
    now=None,
):
    """Evaluate only mature rows strictly after the champion's training cutoff."""
    X = np.asarray(X)
    labels = np.asarray(labels, dtype=int)
    dates = np.asarray(dates).astype(str)
    codes = np.asarray(codes).astype(str)
    if not (len(X) == len(labels) == len(dates) == len(codes)):
        raise ValueError("production backtest arrays must have equal length")
    forecast_arrays = (
        next_up_probabilities,
        next_actual_up,
        next_range_hit,
    )
    if any(value is not None for value in forecast_arrays):
        if not all(value is not None for value in forecast_arrays):
            raise ValueError("next trade day backtest arrays must be complete")
        if any(len(value) != len(labels) for value in forecast_arrays):
            raise ValueError("next trade day backtest arrays must align")

    cutoff = _date_key((meta or {}).get("data_end_date"))
    if len(cutoff) != 8:
        raise ValueError("production model data_end_date is required")
    date_keys = np.asarray([_date_key(value) for value in dates])
    selected = np.flatnonzero(date_keys > cutoff)
    selected_dates = date_keys[selected]
    updated_at = int(time.time() * 1000 if now is None else now)

    report = {
        "schemaVersion": "production-accuracy.v1",
        "mode": "forwardUnseenBacktest",
        "updatedAt": updated_at,
        "model": {
            "trainedAt": int((meta or {}).get("trained_at") or 0),
            "dataEndDate": _display_date(cutoff),
            "horizonDays": int((meta or {}).get("horizon") or 5),
            "featureCount": len((meta or {}).get("feat_names") or []),
            "targetRule": str((meta or {}).get("target_rule") or ""),
        },
        "definition": {
            "prediction": "hitProb >= 50%",
            "actual": str((meta or {}).get("target_rule") or ""),
            "protocol": "mature samples strictly after model data_end_date",
        },
        "overall": _empty_metrics(),
        "strongSignals": {
            "total": 0,
            "correct": 0,
            "accuracyPct": None,
            "coveragePct": None,
            "positiveThresholdPct": int(POSITIVE_THRESHOLD * 100),
            "negativeThresholdPct": int(NEGATIVE_THRESHOLD * 100),
        },
        "nextTradeDayDirection": {
            "total": 0,
            "correct": 0,
            "accuracyPct": None,
        },
        "nextTradeDayRange": {
            "total": 0,
            "covered": 0,
            "coveragePct": None,
            "nominalCoveragePct": 80,
        },
        "days": [],
        "sampleWindow": {
            "from": "",
            "to": "",
            "tradingDates": 0,
        },
    }
    if not len(selected):
        return report

    probabilities = np.asarray(booster.predict(X[selected]), dtype=float)
    if len(probabilities) != len(selected) or not np.isfinite(probabilities).all():
        raise ValueError("production model returned invalid probabilities")
    actual = labels[selected]
    predicted = (probabilities >= 0.5).astype(int)
    correct_mask = predicted == actual
    total = int(len(actual))
    correct = int(np.sum(correct_mask))
    report["overall"] = {
        "total": total,
        "correct": correct,
        "accuracyPct": _pct(correct, total),
        "balancedAccuracyPct": _balanced_accuracy(actual, predicted),
    }

    strong_mask = (
        (probabilities >= POSITIVE_THRESHOLD)
        | (probabilities <= NEGATIVE_THRESHOLD)
    )
    strong_total = int(np.sum(strong_mask))
    strong_correct = int(np.sum(correct_mask[strong_mask]))
    report["strongSignals"] = {
        "total": strong_total,
        "correct": strong_correct,
        "accuracyPct": _pct(strong_correct, strong_total),
        "coveragePct": _pct(strong_total, total),
        "positiveThresholdPct": int(POSITIVE_THRESHOLD * 100),
        "negativeThresholdPct": int(NEGATIVE_THRESHOLD * 100),
    }

    if all(value is not None for value in forecast_arrays):
        next_prob = np.asarray(next_up_probabilities, dtype=float)[selected]
        next_actual = np.asarray(next_actual_up, dtype=int)[selected]
        range_hit = np.asarray(next_range_hit, dtype=int)[selected]
        valid_direction = (
            np.isfinite(next_prob)
            & np.isin(next_actual, (0, 1))
        )
        direction_total = int(np.sum(valid_direction))
        direction_correct = int(np.sum(
            (next_prob[valid_direction] >= 0.5).astype(int)
            == next_actual[valid_direction]
        ))
        report["nextTradeDayDirection"] = {
            "total": direction_total,
            "correct": direction_correct,
            "accuracyPct": _pct(direction_correct, direction_total),
        }
        valid_range = np.isin(range_hit, (0, 1))
        range_total = int(np.sum(valid_range))
        range_covered = int(np.sum(range_hit[valid_range] == 1))
        report["nextTradeDayRange"] = {
            "total": range_total,
            "covered": range_covered,
            "coveragePct": _pct(range_covered, range_total),
            "nominalCoveragePct": 80,
        }

    day_rows = []
    for key in sorted(set(selected_dates), reverse=True):
        mask = selected_dates == key
        day_total = int(np.sum(mask))
        day_correct = int(np.sum(correct_mask[mask]))
        day_rows.append({
            "date": _display_date(key),
            "total": day_total,
            "correct": day_correct,
            "accuracyPct": _pct(day_correct, day_total),
        })
    report["days"] = day_rows
    report["sampleWindow"] = {
        "from": _display_date(min(selected_dates)),
        "to": _display_date(max(selected_dates)),
        "tradingDates": len(set(selected_dates)),
    }
    return report


def upload_production_accuracy(report, *, bucket=None):
    if bucket is None:
        from upload_model import bucket as create_bucket
        bucket = create_bucket()
    payload = json.dumps(
        report,
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8")
    bucket.put_object(
        PRODUCTION_ACCURACY_KEY,
        payload,
        headers={
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
        },
    )
    return PRODUCTION_ACCURACY_KEY
