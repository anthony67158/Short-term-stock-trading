"""Mature frozen feature-pair cohorts without altering the captured decision evidence."""

import argparse
import json
import sqlite3
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from platform_app.contracts.base import utcnow
from platform_app.modules.experiments.forward_research_capture import save
from platform_app.modules.experiments.quant_model_trainer import _verified_database
from platform_app.modules.experiments.ranking_model_trainer import _file_sha256


def settle(capture_root, market_root, output, *, as_of=None):
    now = as_of or utcnow()
    if now.tzinfo is None:
        raise ValueError("FORWARD_SETTLEMENT_TIMEZONE_REQUIRED")
    cohort_path = capture_root / "cohort.json"
    cohort = json.loads(cohort_path.read_text())
    captured = json.loads((capture_root / "report.json").read_text())
    digest = _file_sha256(cohort_path)
    if _file_sha256(capture_root / "quant-inputs.npz") != cohort["quantInputsSha256"]:
        raise ValueError("FORWARD_QUANT_INPUT_CHANGED")
    expected = {r["instrumentId"] for r in cohort["selected"]}
    if (len(captured["samples"]) != len(expected)
            or {r["instrumentId"] for r in captured["samples"]} != expected):
        raise ValueError("FORWARD_COHORT_MEMBERSHIP_CHANGED")
    dates = cohort["outcomeSessions"]
    if len(dates) != 5 or dates != sorted(set(dates)):
        raise ValueError("FORWARD_HORIZON_INVALID")
    terminal_available = datetime.fromisoformat(
        f"{dates[-1][:4]}-{dates[-1][4:6]}-{dates[-1][6:]}T17:00:00+08:00",
    )
    manifest, path = _verified_database(market_root, "market-dataset.v4")
    samples = []
    with sqlite3.connect(f"{path.as_uri()}?mode=ro&immutable=1", uri=True) as market:
        market.row_factory = sqlite3.Row
        for sample in captured["samples"]:
            if sample["cohortSha256"] != digest:
                raise ValueError("FORWARD_COHORT_CHANGED")
            result = dict(sample)
            if sample["status"] == "EXCLUDED":
                samples.append(result)
                continue
            if sample["status"] != "PENDING":
                raise ValueError("FORWARD_CAPTURE_STATUS_INVALID")
            root = capture_root / sample["instrumentId"]
            for name in ("assessment", "input"):
                if _file_sha256(root / f"{name}.json") != sample[f"{name}Sha256"]:
                    raise ValueError("FORWARD_AGENT_INPUT_CHANGED")
            if now < terminal_available:
                result["pendingReason"] = "FIVE_SESSION_HORIZON_NOT_MATURE"
                samples.append(result)
                continue
            bars = market.execute(
                "SELECT d.trade_date,d.open,d.close,d.available_at AS daily_available,"
                "a.factor,a.available_at AS factor_available "
                "FROM daily_bars d JOIN adjustment_factors a "
                "ON a.instrument_id=d.instrument_id AND a.trade_date=d.trade_date "
                "WHERE d.instrument_id=? AND d.trade_date BETWEEN ? AND ? "
                "ORDER BY d.trade_date", (sample["instrumentId"], dates[0], dates[-1]),
            ).fetchall()
            if [r["trade_date"] for r in bars] != dates:
                result["pendingReason"] = "FUTURE_MARKET_PATH_INCOMPLETE"
            elif any(datetime.fromisoformat(r[key]) > now for r in bars
                     for key in ("daily_available", "factor_available")):
                result["pendingReason"] = "FUTURE_MARKET_NOT_YET_AVAILABLE"
            else:
                entry = Decimal(bars[0]["open"]) * Decimal(bars[0]["factor"])
                terminal = Decimal(bars[-1]["close"]) * Decimal(bars[-1]["factor"])
                if not entry.is_finite() or not terminal.is_finite() or min(entry, terminal) <= 0:
                    raise ValueError("FORWARD_OUTCOME_PRICE_INVALID")
                result.update(
                    status="MATURED", matureReturnLabels=True,
                    adjustedGrossReturn=format(terminal / entry - 1, "f"),
                    outcomeSessions=dates,
                    outcomeMeaning="ADJUSTED_NEXT_OPEN_TO_FIFTH_CLOSE_GROSS_BENCHMARK",
                )
            samples.append(result)
    report = {
        "schemaVersion": "forward-cohort-outcomes.v1", "asOf": now.isoformat(),
        "cohortSha256": digest, "captureReportSha256": _file_sha256(capture_root / "report.json"),
        "marketManifest": manifest, "samples": samples,
        "counts": {status: sum(s["status"] == status for s in samples)
                   for status in ("PENDING", "MATURED", "EXCLUDED")},
        "releaseStatus": "UNAVAILABLE", "jointPerformanceValidated": False,
        "limitations": ["FEATURE_PAIR_LABELS_ONLY", "NO_EXECUTION_OR_FEES",
                       "NO_JOINT_POLICY_OR_PAIRED_POLICY_ABLATION", "SMALL_SELECTED_PILOT"],
    }
    save(output, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("capture-root", "market-root", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(settle(args.capture_root, args.market_root, args.output)["counts"]))


if __name__ == "__main__":
    main()
