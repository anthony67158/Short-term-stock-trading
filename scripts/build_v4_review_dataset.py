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
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "qlib-service"
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


def build_dataset(input_root, output):
    root = Path(input_root).expanduser().resolve()
    plan_path = root / "plan.json"
    with open(plan_path, encoding="utf-8") as handle:
        plan = json.load(handle)
    datasets = []
    seen_decisions = set()
    for chunk in plan.get("chunks") or []:
        index = int(chunk["index"])
        source = root / f"chunk-{index:02d}" / (
            "opportunity-outcomes-v4.json.gz"
        )
        if not source.is_file():
            raise FileNotFoundError(source)
        payload = _read_gzip(source)
        outcomes = normalize_review_history_outcomes(payload)
        del payload
        dataset = build_opportunity_review_dataset(
            outcomes,
            feature_schema="v4",
        )
        del outcomes
        decision_ids = set(
            dataset["decision_ids_opportunity"].astype(str).tolist()
        )
        duplicate = seen_decisions.intersection(decision_ids)
        if duplicate:
            raise ValueError(
                f"V4训练分片存在重复事件: {sorted(duplicate)[:3]}"
            )
        seen_decisions.update(decision_ids)
        datasets.append(dataset)
        print(json.dumps({
            "stage": "DATASET_CHUNK",
            "index": index,
            "events": len(dataset["X_all"]),
            "conditional": len(dataset["X"]),
            "opportunity": len(dataset["X_opportunity"]),
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
        "sourceChunks": len(datasets),
        "featureSchema": merged["feature_schema"],
        "featureCount": int(len(merged["feature_names"])),
        "events": int(len(merged["X_all"])),
        "conditionalSamples": int(len(merged["X"])),
        "opportunitySamples": int(len(merged["X_opportunity"])),
        "tradeDates": int(len(set(
            merged["dates_opportunity"].astype(str).tolist()
        ))),
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
    parser.add_argument("--input-root", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    build_dataset(args.input_root, args.output)


if __name__ == "__main__":
    main()
