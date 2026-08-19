"""Forward-only accuracy report for the current production LightGBM model."""

import json
import re
import time
from datetime import datetime, timedelta

import numpy as np


PRODUCTION_ACCURACY_KEY = "quantmodel/production_accuracy.json"
HARD_ERROR_MEMORY_KEY = "quantmodel/hard_error_memory.json"
HARD_ERROR_MEMORY_SCHEMA = "production-hard-errors.v1"
POSITIVE_THRESHOLD = 0.62
NEGATIVE_THRESHOLD = 0.38
CODE_RE = re.compile(r"^(?:sh|sz)\d{6}$")


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


def collect_hard_error_samples(
    booster,
    meta,
    *,
    X,
    labels,
    dates,
    codes,
    now=None,
):
    """Collect whitelisted OOS mistakes; never persist raw bars or features."""
    X = np.asarray(X)
    labels = np.asarray(labels, dtype=int)
    dates = np.asarray(dates).astype(str)
    codes = np.asarray(codes).astype(str)
    if not (len(X) == len(labels) == len(dates) == len(codes)):
        raise ValueError("hard error arrays must have equal length")
    cutoff = _date_key((meta or {}).get("data_end_date"))
    if len(cutoff) != 8:
        raise ValueError("production model data_end_date is required")
    date_keys = np.asarray([_date_key(value) for value in dates])
    selected = np.flatnonzero(date_keys > cutoff)
    if not len(selected):
        return []
    probabilities = np.asarray(booster.predict(X[selected]), dtype=float)
    if len(probabilities) != len(selected) or not np.isfinite(probabilities).all():
        raise ValueError("production model returned invalid probabilities")
    predicted = (probabilities >= 0.5).astype(int)
    actual = labels[selected]
    observed_at = int(time.time() * 1000 if now is None else now)
    samples = []
    for position, probability, prediction, label in zip(
        selected,
        probabilities,
        predicted,
        actual,
    ):
        code = str(codes[position])
        date = str(date_keys[position])
        if (
            prediction == label
            or not CODE_RE.fullmatch(code)
            or len(date) != 8
        ):
            continue
        samples.append({
            "sampleKey": f"{date}:{code}",
            "date": date,
            "code": code,
            "label": int(label),
            "probability": round(float(probability), 6),
            "predicted": int(prediction),
            "confidence": round(
                float(abs(probability - 0.5) * 2.0),
                6,
            ),
            "modelTrainedAt": int((meta or {}).get("trained_at") or 0),
            "firstSeenAt": observed_at,
            "lastSeenAt": observed_at,
            "timesSeen": 1,
        })
    return samples


def _valid_hard_error_sample(value):
    if not isinstance(value, dict):
        return None
    date = _date_key(value.get("date"))
    code = str(value.get("code") or "")
    label = value.get("label")
    probability = value.get("probability")
    try:
        label = int(label)
        probability = float(probability)
    except (TypeError, ValueError):
        return None
    if (
        len(date) != 8
        or not CODE_RE.fullmatch(code)
        or label not in (0, 1)
        or not np.isfinite(probability)
        or probability < 0
        or probability > 1
    ):
        return None
    predicted = int(probability >= 0.5)
    if predicted == label:
        return None
    return {
        "sampleKey": f"{date}:{code}",
        "date": date,
        "code": code,
        "label": label,
        "probability": round(probability, 6),
        "predicted": predicted,
        "confidence": round(abs(probability - 0.5) * 2.0, 6),
        "modelTrainedAt": int(value.get("modelTrainedAt") or 0),
        "firstSeenAt": int(value.get("firstSeenAt") or 0),
        "lastSeenAt": int(value.get("lastSeenAt") or 0),
        "timesSeen": max(1, int(value.get("timesSeen") or 1)),
    }


def merge_hard_error_memory(
    existing,
    incoming,
    *,
    now=None,
    max_samples=4000,
    max_per_class=2000,
    max_age_days=365,
):
    """Deduplicate mistakes and retain a balanced, bounded replay memory."""
    observed_at = int(time.time() * 1000 if now is None else now)
    by_key = {}
    for value in (existing or {}).get("samples") or []:
        sample = _valid_hard_error_sample(value)
        if sample:
            by_key[sample["sampleKey"]] = sample
    for value in incoming or []:
        sample = _valid_hard_error_sample(value)
        if not sample:
            continue
        previous = by_key.get(sample["sampleKey"])
        if previous:
            sample["firstSeenAt"] = previous["firstSeenAt"]
            sample["timesSeen"] = previous["timesSeen"] + 1
        sample["lastSeenAt"] = observed_at
        by_key[sample["sampleKey"]] = sample

    samples = list(by_key.values())
    if samples and max_age_days > 0:
        latest = max(
            datetime.strptime(sample["date"], "%Y%m%d")
            for sample in samples
        )
        cutoff = latest - timedelta(days=int(max_age_days))
        samples = [
            sample for sample in samples
            if datetime.strptime(sample["date"], "%Y%m%d") >= cutoff
        ]

    retained = []
    for label in (0, 1):
        group = [sample for sample in samples if sample["label"] == label]
        group.sort(
            key=lambda sample: (
                sample["timesSeen"],
                sample["date"],
                sample["confidence"],
                sample["lastSeenAt"],
            ),
            reverse=True,
        )
        retained.extend(group[:max(0, int(max_per_class))])
    retained.sort(
        key=lambda sample: (
            sample["date"],
            sample["timesSeen"],
            sample["confidence"],
        ),
        reverse=True,
    )
    retained = retained[:max(0, int(max_samples))]
    by_class = {
        str(label): sum(sample["label"] == label for sample in retained)
        for label in (0, 1)
    }
    return {
        "schemaVersion": HARD_ERROR_MEMORY_SCHEMA,
        "updatedAt": observed_at,
        "total": len(retained),
        "byClass": by_class,
        "samples": retained,
    }


def load_hard_error_memory(*, bucket=None):
    if bucket is None:
        from upload_model import bucket as create_bucket
        bucket = create_bucket()
    try:
        payload = json.loads(
            bucket.get_object(HARD_ERROR_MEMORY_KEY)
            .read()
            .decode("utf-8")
        )
    except Exception as error:
        if (
            getattr(error, "status", None) == 404
            or getattr(error, "code", None) == "NoSuchKey"
        ):
            payload = {}
        else:
            raise
    if payload.get("schemaVersion") != HARD_ERROR_MEMORY_SCHEMA:
        return {
            "schemaVersion": HARD_ERROR_MEMORY_SCHEMA,
            "updatedAt": 0,
            "total": 0,
            "byClass": {"0": 0, "1": 0},
            "samples": [],
        }
    return payload


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


def _positive_int(value):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, number)


def _history_day(value, fallback_model):
    if not isinstance(value, dict):
        return None
    date = _display_date(value.get("date"))
    total = _positive_int(value.get("total"))
    correct = min(total, _positive_int(value.get("correct")))
    if not date or total <= 0:
        return None
    return {
        "date": date,
        "total": total,
        "correct": correct,
        "accuracyPct": _pct(correct, total),
        "modelDataEndDate": _display_date(
            value.get("modelDataEndDate")
            or (fallback_model or {}).get("dataEndDate")
            or (fallback_model or {}).get("data_end_date"),
        ),
        "modelTrainedAt": _positive_int(
            value.get("modelTrainedAt")
            or (fallback_model or {}).get("trainedAt")
            or (fallback_model or {}).get("trained_at"),
        ),
    }


def merge_production_accuracy_history(existing, report):
    """Keep one immutable forward result per signal date across model releases."""
    existing = existing if isinstance(existing, dict) else {}
    report = report if isinstance(report, dict) else {}
    by_date = {}
    existing_rows = existing.get("historyDays") or existing.get("days") or []
    for value in existing_rows:
        row = _history_day(value, existing.get("model") or {})
        if row and row["date"] not in by_date:
            by_date[row["date"]] = row

    current_model = report.get("model") or {}
    for value in report.get("days") or []:
        row = _history_day(value, current_model)
        if not row:
            continue
        prior = by_date.get(row["date"])
        if prior is None or prior["modelDataEndDate"] == row["modelDataEndDate"]:
            by_date[row["date"]] = row

    merged = dict(report)
    merged["historyDays"] = sorted(
        by_date.values(),
        key=lambda value: value["date"],
        reverse=True,
    )
    return merged


def _load_production_accuracy(bucket):
    get_object = getattr(bucket, "get_object", None)
    if not callable(get_object):
        return {}
    try:
        return json.loads(
            get_object(PRODUCTION_ACCURACY_KEY).read().decode("utf-8"),
        )
    except Exception as error:  # noqa: BLE001
        if (
            getattr(error, "status", None) == 404
            or getattr(error, "code", None) == "NoSuchKey"
        ):
            return {}
        raise


def upload_production_accuracy(report, *, bucket=None):
    if bucket is None:
        from upload_model import bucket as create_bucket
        bucket = create_bucket()
    merged_report = merge_production_accuracy_history(
        _load_production_accuracy(bucket),
        report,
    )
    report.clear()
    report.update(merged_report)
    payload = json.dumps(
        merged_report,
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


def upload_hard_error_memory(memory, *, bucket=None):
    if bucket is None:
        from upload_model import bucket as create_bucket
        bucket = create_bucket()
    payload = json.dumps(
        memory,
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8")
    bucket.put_object(
        HARD_ERROR_MEMORY_KEY,
        payload,
        headers={
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
        },
    )
    return HARD_ERROR_MEMORY_KEY
