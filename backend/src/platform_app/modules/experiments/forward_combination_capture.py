"""Freeze current cross-sectional predictions, then capture a prospective Agent cohort."""

import argparse
import asyncio
import json
import sqlite3
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import joblib
import numpy as np

from platform_app.contracts.base import utcnow
from platform_app.modules.decisions.position_runtime import _current_feature_rows
from platform_app.modules.experiments.forward_research_capture import capture, save
from platform_app.modules.experiments.joint_bundle import encode_agent_assessment
from platform_app.modules.experiments.quant_model_trainer import _verified_database
from platform_app.modules.experiments.ranking_combination import (
    CANDIDATES, combination_scores, daily_percentiles,
)
from platform_app.modules.experiments.ranking_model_trainer import (
    MODEL_FEATURE_NAMES, _date_features, _file_sha256,
)


def freeze(experiment: Path, market_root: Path, output: Path, *, cohort_policy="board-pilot"):
    """No outcomes are loaded. Freshness and training boundaries fail closed."""
    started = utcnow()
    local = started.astimezone(ZoneInfo("Asia/Shanghai"))
    manifest, market_path = _verified_database(market_root, "market-dataset.v4")
    protocol = json.loads((experiment / "protocol.json").read_text())
    if protocol["featureNames"] != list(MODEL_FEATURE_NAMES):
        raise ValueError("FORWARD_FEATURE_SCHEMA_MISMATCH")
    for name, digest in protocol["sourceHashes"].items():
        if _file_sha256(Path(__file__).with_name(name)) != digest:
            raise ValueError("FORWARD_TRAINING_SOURCE_CHANGED")
    with sqlite3.connect(f"{market_path.as_uri()}?mode=ro&immutable=1", uri=True) as market:
        market.row_factory = sqlite3.Row
        sessions = [r[0] for r in market.execute(
            "SELECT cal_date FROM trade_calendar WHERE exchange='SSE' AND is_open=1 "
            "ORDER BY cal_date",
        )]
        today = local.strftime("%Y%m%d")
        observed = [d for d in sessions if d < today or (d == today and local.hour >= 17)]
        if not observed:
            raise ValueError("FORWARD_CALENDAR_UNAVAILABLE")
        decision_date = observed[-1]
        latest = market.execute("SELECT MAX(trade_date) FROM daily_bars").fetchone()[0]
        if latest != decision_date:
            raise ValueError("FORWARD_MARKET_NOT_CURRENT")
        future = [d for d in sessions if d > today or
                  (d == today and (local.hour, local.minute) < (9, 30))][:5]
        if len(future) != 5:
            raise ValueError("FORWARD_OUTCOME_CALENDAR_INCOMPLETE")
        rows, prices, available, _ = _current_feature_rows(market, decision_date, started)
        names = dict(market.execute("SELECT instrument_id,name FROM instruments"))
    if not rows or {r["board"] for r in rows} != {"MAIN", "CHINEXT", "STAR", "BEIJING"}:
        raise ValueError("FORWARD_UNIVERSE_INCOMPLETE")
    x, _ = _date_features(rows)
    splits = json.loads((experiment / "splits.json").read_text())["folds"]
    split = splits[-1]
    if int(split["testEnd"]) >= int(future[0]):
        raise ValueError("FORWARD_START_OVERLAPS_DEVELOPMENT")
    fold_root = experiment / f"fold-{split['fold']}"
    evaluation = json.loads((fold_root / "evaluation.json").read_text())
    weights = np.asarray([evaluation["weights"][name] for name in CANDIDATES])
    if not np.isfinite(weights).all() or np.any(weights < 0) or not np.isclose(weights.sum(), 1):
        raise ValueError("FORWARD_FUSION_WEIGHTS_INVALID")
    predictions, hashes = [], {}
    for name in CANDIDATES:
        path = fold_root / f"{name}.joblib"
        receipt = json.loads(path.with_suffix(".json").read_text())
        hashes[name] = _file_sha256(path)
        if (hashes[name] != receipt["modelSha256"]
                or int(receipt["trainEnd"]) != int(split["trainEnd"])):
            raise ValueError("FORWARD_MODEL_LINEAGE_MISMATCH")
        predictions.append(joblib.load(path).predict(x))
    normalized = daily_percentiles(
        np.full(len(rows), int(decision_date)), np.column_stack(predictions),
    )
    scores = combination_scores(normalized, weights)
    # Membership is fixed before any Agent response, including eventual failed captures.
    chosen = {}
    if cohort_policy == "board-pilot":
        for board in ("MAIN", "CHINEXT", "STAR", "BEIJING"):
            indices = [i for i, row in enumerate(rows) if row["board"] == board]
            index = max(indices, key=lambda i: (float(scores["equal"][i]), rows[i]["instrument_id"]))
            chosen[index] = ["equal_board_leader"]
    elif cohort_policy == "candidate-union":
        for name, values in scores.items():
            for index in np.argsort(values, kind="stable")[-min(10, len(rows)):]:
                chosen.setdefault(int(index), []).append(name)
    else:
        raise ValueError("FORWARD_COHORT_POLICY_INVALID")
    selected = []
    for index in sorted(chosen):
        row = rows[index]
        selected.append({
            "instrumentId": row["instrument_id"], "name": names[row["instrument_id"]],
            "board": row["board"], "snapshotPrice": prices[row["instrument_id"]],
            "selectedBy": chosen[index],
            "featureAvailableAt": available[row["instrument_id"]].isoformat(),
            "scores": {name: float(values[index]) for name, values in scores.items()},
        })
    output.mkdir(parents=True, exist_ok=False)
    np.savez_compressed(
        output / "quant-inputs.npz", features=x,
        instruments=np.array([r["instrument_id"] for r in rows]),
        predictions=np.column_stack(predictions), normalized=normalized,
    )
    frozen = {
        "schemaVersion": "forward-combination-cohort.v1", "frozenAt": utcnow().isoformat(),
        "featureAsOf": started.isoformat(), "marketDate": decision_date,
        "marketManifest": manifest, "experimentProtocol": protocol, "modelHashes": hashes,
        "split": split, "fusionWeights": dict(zip(CANDIDATES, weights.tolist(), strict=True)),
        "quantInputsSha256": _file_sha256(output / "quant-inputs.npz"),
        "captureSourceSha256": _file_sha256(Path(__file__)),
        "cohortPolicy": cohort_policy,
        "eligibleUniverse": len(rows), "selected": selected, "outcomeSessions": future,
        "outcomeEntryDeadline": f"{future[0][:4]}-{future[0][4:6]}-{future[0][6:]}T09:30:00+08:00",
        "usage": "RESEARCH_ONLY", "productionReady": False,
        "limitation": "Feature pairing pilot; no fitted joint policy or validated Agent uplift.",
    }
    save(output / "cohort.json", frozen)
    return frozen


async def run(experiment, market_root, output, *, cohort_policy="board-pilot"):
    frozen = freeze(experiment, market_root, output, cohort_policy=cohort_policy)
    samples = []
    for item in frozen["selected"]:
        root = output / item["instrumentId"]
        result = await capture(root, item["instrumentId"], item["name"])
        sample = {
            **item, "capture": result, "status": "EXCLUDED",
            "cohortSha256": _file_sha256(output / "cohort.json"),
            "exclusionReason": result.get("errorCode"), "matureReturnLabels": False,
        }
        completed = datetime.fromisoformat(result["completedAt"])
        if result["status"] == "VALIDATED":
            entry = datetime.fromisoformat(frozen["outcomeEntryDeadline"])
            assessment = json.loads((root / "assessment.json").read_text())
            if completed >= entry:
                sample["exclusionReason"] = "CAPTURE_MISSED_FROZEN_ENTRY_DEADLINE"
            elif datetime.fromisoformat(assessment["valid_until"]) <= entry:
                sample["exclusionReason"] = "ASSESSMENT_EXPIRES_BEFORE_ENTRY"
            else:
                sample.update(
                    status="PENDING", exclusionReason=None,
                    agentFeatures=encode_agent_assessment(assessment),
                    assessmentSha256=_file_sha256(root / "assessment.json"),
                    inputSha256=_file_sha256(root / "input.json"),
                    validUntil=assessment["valid_until"],
                )
        save(root / "paired-sample.json", sample)
        samples.append(sample)
        print(json.dumps({"instrumentId": item["instrumentId"], "status": sample["status"]}),
              flush=True)
    report = {
        "schemaVersion": frozen["schemaVersion"], "samples": samples,
        "releaseStatus": "UNAVAILABLE", "jointPerformanceValidated": False,
        "matureSamples": 0, "completedAt": utcnow().isoformat(),
    }
    save(output / "report.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("experiment", "market-root", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--cohort-policy", choices=("board-pilot", "candidate-union"),
                        default="board-pilot")
    args = parser.parse_args()
    asyncio.run(run(args.experiment, args.market_root, args.output, cohort_policy=args.cohort_policy))


if __name__ == "__main__":
    main()
