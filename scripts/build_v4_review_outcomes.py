#!/usr/bin/env python3
"""Build causally aligned 176-dimensional V4 review outcomes.

The historical replay already stores two independently validated inputs:
  - reviewScoreInput: 32 trigger-observation features;
  - scoreInput: 136 initial decision features.

This script joins those inputs with the 8-dimensional Alpha158 block. CLOSE
decisions may use the same-day close snapshot; INTRADAY decisions can only use
the previous available trading-day snapshot. Missing Alpha rows remain valid
training samples with neutral values plus Missing masks.
"""

from __future__ import annotations

import argparse
import bisect
import gzip
import hashlib
import json
import math
import os
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_DIR = ROOT / "qlib-service" / "contracts"
V4_SCHEMA = "opportunity-review-feature.v4"
V2_SCHEMA = "opportunity-review-feature.v2"
V3_SCHEMA = "opportunity-review-feature.v3"
SCORE_SCHEMA = "opportunity-score-feature.v6"
OUTPUT_SCHEMA = "opportunity-review-v4-bootstrap.v1"


def _contract(name):
    with open(CONTRACT_DIR / name, encoding="utf-8") as handle:
        return json.load(handle)


BASE_NAMES = tuple(_contract("opportunity-review-features-v2.json")["featureNames"])
INITIAL_NAMES = tuple(_contract("opportunity-score-features.json")["featureNames"])
ALPHA_NAMES = tuple(_contract("opportunity-alpha158-signal.json")["featureNames"])
FEATURE_NAMES_V4 = (
    *BASE_NAMES,
    *(f"initial_{name}" for name in INITIAL_NAMES),
    *(f"alpha_{name}" for name in ALPHA_NAMES),
)
FEATURE_NAMES_V3 = (
    *BASE_NAMES,
    *(f"initial_{name}" for name in INITIAL_NAMES),
)


def _open_json(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _finite(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _compact_date(value):
    digits = "".join(character for character in str(value or "") if character.isdigit())
    return digits[:8] if len(digits) >= 8 else ""


def _alpha_date(outcome, available_dates):
    trade_date = _compact_date(outcome.get("tradeDate"))
    if not trade_date:
        return None
    mode = str(outcome.get("mode") or "").upper()
    if mode == "CLOSE":
        return trade_date if trade_date in available_dates else None
    position = bisect.bisect_left(available_dates, trade_date)
    return available_dates[position - 1] if position > 0 else None


def _neutral_alpha():
    return {
        "alphaScoreZ": 0.0,
        "alphaScorePctRank": 0.0,
        "alphaScoreZMissing": 1.0,
        "alphaRankIc20": 0.0,
        "alphaRankIc60": 0.0,
        "alphaRankIcMissing": 1.0,
        "alphaScoreMomentum5": 0.0,
        "alphaScoreMomentumMissing": 1.0,
    }


def _alpha_values(row):
    if not isinstance(row, dict):
        return _neutral_alpha(), False
    values = {
        "alphaScoreZ": _finite(row.get("centeredZ")),
        "alphaScorePctRank": _finite(row.get("percentile")),
        "alphaRankIc20": _finite(row.get("rankIc20")),
        "alphaRankIc60": _finite(row.get("rankIc60")),
        "alphaScoreMomentum5": _finite(row.get("scoreMomentum5")),
    }
    if any(value is None for value in values.values()):
        return _neutral_alpha(), False
    return {
        "alphaScoreZ": max(-1.0, min(1.0, values["alphaScoreZ"])),
        "alphaScorePctRank": max(
            0.0,
            min(1.0, values["alphaScorePctRank"]),
        ),
        "alphaScoreZMissing": 0.0,
        "alphaRankIc20": max(-1.0, min(1.0, values["alphaRankIc20"])),
        "alphaRankIc60": max(-1.0, min(1.0, values["alphaRankIc60"])),
        "alphaRankIcMissing": 0.0,
        "alphaScoreMomentum5": max(
            -1.0,
            min(1.0, values["alphaScoreMomentum5"]),
        ),
        "alphaScoreMomentumMissing": 0.0,
    }, True


def _ordered_factors(base_factors, initial_factors, alpha_values):
    factors = {
        **{name: base_factors[name] for name in BASE_NAMES},
        **{
            f"initial_{name}": initial_factors[name]
            for name in INITIAL_NAMES
        },
        **{
            f"alpha_{name}": alpha_values[name]
            for name in ALPHA_NAMES
        },
    }
    if tuple(factors) != FEATURE_NAMES_V4:
        raise ValueError("V4特征顺序与合同不一致")
    if any(_finite(value) is None for value in factors.values()):
        raise ValueError("V4特征必须全部为有限数值")
    return factors


def augment_outcome(outcome, alpha_by_key, alpha_dates):
    if not isinstance(outcome, dict) or outcome.get("maturity") != "MATURED":
        return None, "NOT_MATURED"
    review = outcome.get("reviewScoreInput")
    initial = outcome.get("scoreInput")
    if not isinstance(review, dict):
        return None, "REVIEW_INPUT_MISSING"
    review_schema = review.get("schemaVersion")
    review_factors = review.get("factors") or {}
    if review_schema == V2_SCHEMA:
        if tuple(review_factors) != BASE_NAMES:
            return None, "REVIEW_V2_INCOMPLETE"
    elif review_schema == V3_SCHEMA:
        if tuple(review_factors) != FEATURE_NAMES_V3:
            return None, "REVIEW_V3_INCOMPLETE"
    else:
        return None, "REVIEW_SCHEMA_UNSUPPORTED"
    if (
        not isinstance(initial, dict)
        or initial.get("schemaVersion") != SCORE_SCHEMA
        or tuple((initial.get("factors") or {}).keys()) != INITIAL_NAMES
    ):
        return None, "INITIAL_V6_INCOMPLETE"
    initial_at = int(initial.get("asOf") or 0)
    review_at = int(review.get("asOf") or 0)
    if initial_at <= 0 or review_at <= 0 or initial_at > review_at:
        return None, "NON_CAUSAL_TIMESTAMP"

    alpha_date = _alpha_date(outcome, alpha_dates)
    code = str(outcome.get("code") or "")
    alpha_row = alpha_by_key.get((alpha_date, code)) if alpha_date else None
    alpha_values, alpha_available = _alpha_values(alpha_row)
    if review_schema == V3_SCHEMA:
        factors = {
            **review_factors,
            **{
                f"alpha_{name}": alpha_values[name]
                for name in ALPHA_NAMES
            },
        }
        if tuple(factors) != FEATURE_NAMES_V4:
            raise ValueError("V4特征顺序与合同不一致")
    else:
        factors = _ordered_factors(
            review_factors,
            initial["factors"],
            alpha_values,
        )
    context = dict(outcome.get("context") or {})
    context["v4Bootstrap"] = {
        "schemaVersion": OUTPUT_SCHEMA,
        "baseFeatureSchema": review_schema,
        "initialFeatureSchema": SCORE_SCHEMA,
        "alphaFeatureSchema": "opportunity-alpha158-signal.v1",
        "alphaAsOfDate": alpha_date,
        "alphaAvailable": alpha_available,
        "alphaTiming": (
            "SAME_DAY_CLOSE"
            if str(outcome.get("mode") or "").upper() == "CLOSE"
            else "PREVIOUS_TRADING_DAY"
        ),
    }
    return {
        **outcome,
        "reviewScoreInput": {
            **review,
            "schemaVersion": V4_SCHEMA,
            "factors": factors,
        },
        "context": context,
    }, None


def build_v4_outcomes(payload, alpha_snapshot):
    outcomes = (
        payload
        if isinstance(payload, list)
        else payload.get("outcomes", [])
    )
    alpha_rows = (
        alpha_snapshot.get("rows", [])
        if isinstance(alpha_snapshot, dict)
        else []
    )
    alpha_by_key = {
        (_compact_date(row.get("date")), str(row.get("code") or "")): row
        for row in alpha_rows
    }
    alpha_dates = sorted({
        date
        for date, _code in alpha_by_key
        if date
    })
    result = []
    excluded = Counter()
    alpha_available = 0
    by_mode = Counter()
    for outcome in outcomes:
        augmented, reason = augment_outcome(
            outcome,
            alpha_by_key,
            alpha_dates,
        )
        if augmented is None:
            excluded[reason] += 1
            continue
        result.append(augmented)
        bootstrap = augmented["context"]["v4Bootstrap"]
        alpha_available += int(bootstrap["alphaAvailable"])
        by_mode[str(augmented.get("mode") or "UNKNOWN")] += 1

    dates = sorted({
        str(value.get("tradeDate") or "")
        for value in result
        if value.get("tradeDate")
    })
    summary = {
        "inputOutcomes": len(outcomes),
        "v4Outcomes": len(result),
        "featureCount": len(FEATURE_NAMES_V4),
        "tradeDates": len(dates),
        "startDate": dates[0] if dates else None,
        "endDate": dates[-1] if dates else None,
        "alphaAvailable": alpha_available,
        "alphaMissing": len(result) - alpha_available,
        "alphaCoverage": (
            round(alpha_available / len(result), 6)
            if result else 0.0
        ),
        "byMode": dict(sorted(by_mode.items())),
        "excluded": dict(sorted(excluded.items())),
    }
    return {
        "schemaVersion": OUTPUT_SCHEMA,
        "source": {
            "type": "HISTORICAL_CAUSAL_REPLAY",
            "reviewFeatureSchema": V4_SCHEMA,
            "alphaTimingPolicy": "CLOSE_SAME_DAY_INTRADAY_PREVIOUS_DAY",
        },
        "summary": summary,
        "outcomes": result,
    }


def _write_json(path, payload):
    destination = os.path.abspath(path)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    opener = gzip.open if destination.endswith(".gz") else open
    with opener(destination, "wt", encoding="utf-8") as handle:
        json.dump(
            payload,
            handle,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--outcomes", required=True)
    parser.add_argument("--alpha-snapshot", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report")
    args = parser.parse_args()

    alpha_snapshot = os.path.abspath(
        os.path.expanduser(args.alpha_snapshot),
    )
    alpha_snapshot_sha256 = _sha256_file(alpha_snapshot)
    payload = build_v4_outcomes(
        _open_json(args.outcomes),
        _open_json(alpha_snapshot),
    )
    payload["source"]["alphaSnapshotSha256"] = alpha_snapshot_sha256
    payload["summary"]["alphaSnapshotSha256"] = alpha_snapshot_sha256
    _write_json(args.output, payload)
    if args.report:
        _write_json(args.report, payload["summary"])
    print(json.dumps(payload["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
