#!/usr/bin/env python3
"""Build a memory-bounded NPZ training dataset from V4 replay chunks."""

from __future__ import annotations

import argparse
import gc
import gzip
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "qlib-service"
CHINA_TIMEZONE = timezone(timedelta(hours=8))
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from decision_engine.training.review_dataset import (  # noqa: E402
    build_opportunity_review_dataset,
    merge_opportunity_review_datasets,
    normalize_review_history_outcomes,
    save_opportunity_review_dataset,
)


def _read_gzip(path):
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _deduplicate_outcomes(outcomes, seen):
    unique = []
    duplicates = 0
    for outcome in outcomes:
        decision_id = str((outcome or {}).get("decisionId") or "")
        if not decision_id:
            unique.append(outcome)
            continue
        digest = hashlib.sha256(json.dumps(
            outcome,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")).hexdigest()
        previous = seen.get(decision_id)
        if previous is None:
            seen[decision_id] = digest
            unique.append(outcome)
        elif previous == digest:
            duplicates += 1
        else:
            raise ValueError(f"V4训练源存在冲突事件: {decision_id}")
    return unique, duplicates


def _compact_date(value):
    digits = "".join(
        character
        for character in str(value or "")
        if character.isdigit()
    )
    return digits[:8] if len(digits) >= 8 else ""


def _within_root_date_range(outcome, start, end):
    date = _compact_date(outcome.get("tradeDate"))
    if not date:
        return start is None and end is None
    return (
        (start is None or date >= start)
        and (end is None or date < end)
    )


def _event_end_date(outcome):
    for value in (
        (outcome.get("exit") or {}).get("tradeDate"),
        (outcome.get("entry") or {}).get("tradeDate"),
    ):
        date = _compact_date(value)
        if date:
            return date
    try:
        timestamp = int(outcome.get("evaluatedAt") or 0) / 1000
    except (TypeError, ValueError):
        return ""
    return (
        datetime.fromtimestamp(timestamp, tz=timezone.utc)
        .astimezone(CHINA_TIMEZONE)
        .strftime("%Y%m%d")
        if timestamp > 0 else ""
    )


def _corporate_action_keys(daily_rows):
    by_code = {}
    for row in daily_rows:
        code = str((row or {}).get("code") or "")
        date = _compact_date((row or {}).get("date"))
        try:
            close = float((row or {}).get("close"))
            pre_close = float((row or {}).get("preClose"))
        except (TypeError, ValueError):
            continue
        if code and date and close > 0 and pre_close > 0:
            by_code.setdefault(code, []).append((date, close, pre_close))
    actions = {}
    for code, rows in by_code.items():
        ordered = sorted(rows)
        for previous, current in zip(ordered, ordered[1:]):
            if abs(current[2] - previous[1]) > 0.005:
                actions.setdefault(code, set()).add(current[0])
    return actions


def _crosses_corporate_action(outcome, actions):
    code = str(outcome.get("code") or "")
    start = _compact_date(
        outcome.get("signalTradeDate") or outcome.get("tradeDate"),
    )
    end = _event_end_date(outcome)
    return bool(
        code
        and start
        and end
        and any(
            start < date <= end
            for date in actions.get(code, ())
        )
    )


def build_dataset(input_root, output, *, root_cutovers=None):
    roots = (
        list(input_root)
        if isinstance(input_root, (list, tuple))
        else [input_root]
    )
    cutovers = [
        _compact_date(value)
        for value in (root_cutovers or [])
    ]
    if len(cutovers) != max(0, len(roots) - 1):
        raise ValueError("多根训练源必须为每个相邻根提供一个日期切点")
    if any(not value for value in cutovers):
        raise ValueError("训练源日期切点必须为YYYYMMDD")
    if cutovers != sorted(set(cutovers)):
        raise ValueError("训练源日期切点必须严格递增且不重复")
    datasets = []
    seen_decisions = {}
    corporate_action_excluded = 0
    duplicate_events = 0
    date_range_excluded = 0
    source_chunks = 0
    for root_index, input_root_value in enumerate(roots):
        range_start = cutovers[root_index - 1] if root_index > 0 else None
        range_end = (
            cutovers[root_index]
            if root_index < len(cutovers)
            else None
        )
        root = Path(input_root_value).expanduser().resolve()
        plan_path = root / "plan.json"
        with open(plan_path, encoding="utf-8") as handle:
            plan = json.load(handle)
        for chunk in plan.get("chunks") or []:
            index = int(chunk["index"])
            directory = root / f"chunk-{index:02d}"
            source = directory / (
                "opportunity-outcomes-v4.json.gz"
            )
            if not source.is_file():
                raise FileNotFoundError(source)
            payload = _read_gzip(source)
            daily_path = directory / "daily.json.gz"
            if not daily_path.is_file():
                raise FileNotFoundError(daily_path)
            actions = _corporate_action_keys(_read_gzip(daily_path))
            source_outcomes = payload.get("outcomes") or []
            ranged_outcomes = [
                outcome
                for outcome in source_outcomes
                if _within_root_date_range(
                    outcome,
                    range_start,
                    range_end,
                )
            ]
            date_range_excluded += (
                len(source_outcomes) - len(ranged_outcomes)
            )
            eligible_outcomes = [
                outcome
                for outcome in ranged_outcomes
                if not _crosses_corporate_action(outcome, actions)
            ]
            corporate_action_excluded += (
                len(ranged_outcomes) - len(eligible_outcomes)
            )
            eligible_outcomes, duplicate_count = _deduplicate_outcomes(
                eligible_outcomes,
                seen_decisions,
            )
            duplicate_events += duplicate_count
            payload = {"outcomes": eligible_outcomes}
            outcomes = normalize_review_history_outcomes(payload)
            del payload
            dataset = build_opportunity_review_dataset(
                outcomes,
                feature_schema="v4",
            )
            del outcomes
            datasets.append(dataset)
            source_chunks += 1
            print(json.dumps({
                "stage": "DATASET_CHUNK",
                "root": str(root),
                "index": index,
                "events": len(dataset["X_all"]),
                "conditional": len(dataset["X"]),
                "opportunity": len(dataset["X_opportunity"]),
                "rangeStart": range_start,
                "rangeEndExclusive": range_end,
                "duplicatesSkipped": duplicate_count,
            }), flush=True)
            gc.collect()

    merged = merge_opportunity_review_datasets(datasets)
    destination = Path(output).expanduser().resolve()
    save_opportunity_review_dataset(destination, merged)
    names = merged["feature_names"].astype(str).tolist()
    missing_indices = [
        index
        for index, name in enumerate(names)
        if name.startswith("alpha_") and name.endswith("Missing")
    ]
    alpha_available = (
        np.all(
            merged["X_opportunity"][:, missing_indices] == 0,
            axis=1,
        )
        if missing_indices
        else np.zeros(len(merged["X_opportunity"]), dtype=bool)
    )
    audit = {
        "schemaVersion": "v4-review-dataset-audit.v1",
        "sourceRoots": len(roots),
        "sourceChunks": source_chunks,
        "rootCutovers": cutovers,
        "dateRangeExcluded": date_range_excluded,
        "duplicateEventsSkipped": duplicate_events,
        "featureSchema": merged["feature_schema"],
        "featureCount": int(len(merged["feature_names"])),
        "events": int(len(merged["X_all"])),
        "conditionalSamples": int(len(merged["X"])),
        "opportunitySamples": int(len(merged["X_opportunity"])),
        "tradeDates": int(len(set(
            merged["dates_opportunity"].astype(str).tolist()
        ))),
        "corporateActionExcluded": corporate_action_excluded,
        "alphaCoverage": round(float(np.mean(alpha_available)), 6),
        "stress10Coverage": round(float(np.mean(
            merged["stress10_available_opportunity"],
        )), 6),
        "output": str(destination),
        "size": destination.stat().st_size,
        "sha256": _sha256(destination),
    }
    audit_path = destination.with_suffix(".audit.json")
    temporary = audit_path.with_suffix(".json.part")
    temporary.write_text(
        json.dumps(audit, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, audit_path)
    print(json.dumps({"stage": "DATASET_DONE", **audit}), flush=True)
    return audit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-root", required=True, action="append")
    parser.add_argument("--root-cutover", action="append", default=[])
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    build_dataset(
        args.input_root,
        args.output,
        root_cutovers=args.root_cutover,
    )


if __name__ == "__main__":
    main()
