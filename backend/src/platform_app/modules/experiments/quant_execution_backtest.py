"""Out-of-time execution evaluation for ranked full-universe selections."""

import hashlib
import json
import math
import os
import sqlite3
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from platform_app.modules.experiments.execution_backtest import (
    COVERAGE_SCHEMA_VERSION,
    _verified_dataset,
)
from platform_app.modules.experiments.quant_model_bundle import QuantModelBundle
from platform_app.modules.experiments.quant_model_trainer import (
    ENRICHED_BASE_FEATURE_NAMES,
    ENRICHED_SCENARIO_FEATURE_NAMES,
    QuantModelError,
    _selected_ranking_features,
)

BACKTEST_SCHEMA_VERSION = "quant-execution-backtest.v1"
STRESS_COST = 0.001


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _cohort_metrics(rows: list[dict]) -> dict:
    actual = np.asarray(
        [row["actualReturnOnRequestedCapital"] for row in rows],
        dtype=np.float64,
    )
    stressed = np.asarray(
        [row["actualReturnAt10BpsStress"] for row in rows],
        dtype=np.float64,
    )
    predicted = np.asarray(
        [row["predictedUtilityAt10BpsStress"] for row in rows],
        dtype=np.float64,
    )
    filled = [row for row in rows if row["pFillLabel"]]
    correlation = None
    if (
        len(rows) > 1
        and float(np.std(predicted)) > 0
        and float(np.std(stressed)) > 0
    ):
        correlation = float(np.corrcoef(predicted, stressed)[0, 1])
    return {
        "selections": len(rows),
        "filled": len(filled),
        "fillRate": len(filled) / len(rows) if rows else None,
        "fullFillRate": (
            sum(bool(row["pFullFillLabel"]) for row in rows) / len(rows)
            if rows
            else None
        ),
        "positiveRate": (
            sum(row["actualReturnOnRequestedCapital"] > 0 for row in rows)
            / len(rows)
            if rows
            else None
        ),
        "meanReturnOnRequestedCapital": (
            float(np.mean(actual)) if len(actual) else None
        ),
        "medianReturnOnRequestedCapital": (
            float(np.median(actual)) if len(actual) else None
        ),
        "meanReturnAt10BpsStress": (
            float(np.mean(stressed)) if len(stressed) else None
        ),
        "predictedActualCorrelation": correlation,
        "q10Q90CoverageGivenFill": (
            sum(
                row["q10"] <= row["netReturnGivenFill"] <= row["q90"]
                for row in filled
            )
            / len(filled)
            if filled
            else None
        ),
        "exitReasons": dict(sorted(Counter(row["exitReason"] for row in rows).items())),
    }


def _quantile_diagnostics(rows: list[dict]) -> list[dict]:
    ordered = sorted(
        rows,
        key=lambda row: (
            row["predictedUtilityAt10BpsStress"],
            row["decisionDate"],
            row["instrumentId"],
        ),
    )
    return [
        {
            "bucket": index + 1,
            "direction": "LOW_TO_HIGH_PREDICTED_UTILITY",
            **_cohort_metrics(list(bucket)),
        }
        for index, bucket in enumerate(np.array_split(np.asarray(ordered, dtype=object), 5))
        if len(bucket)
    ]


def _is_non_decreasing(values: list[float]) -> bool:
    return all(left <= right for left, right in zip(values, values[1:]))


def _preferred_label_rows(database: sqlite3.Connection) -> list[sqlite3.Row]:
    return database.execute(
        "WITH preferred AS ("
        "SELECT l.*, ROW_NUMBER() OVER ("
        "PARTITION BY l.decision_date, l.instrument_id "
        "ORDER BY l.reference_100k DESC, "
        "ABS(CAST(l.target_notional_cny AS REAL) - 100000), l.target_shares"
        ") AS scenario_rank FROM episode_labels l"
        ") SELECT * FROM preferred WHERE scenario_rank = 1 "
        "ORDER BY decision_date, instrument_id"
    ).fetchall()


def write_quant_execution_backtest(
    *,
    coverage_audit_path: Path,
    ranking_dataset_root: Path,
    quant_model_root: Path,
    label_dataset_root: Path,
    output_path: Path,
) -> dict:
    coverage_audit_path = coverage_audit_path.resolve()
    coverage_audit = json.loads(coverage_audit_path.read_text())
    if coverage_audit.get("schemaVersion") != COVERAGE_SCHEMA_VERSION:
        raise QuantModelError("BACKTEST_COVERAGE_AUDIT_INVALID")
    ranking_manifest_path = ranking_dataset_root.resolve() / "manifest.json"
    ranking_manifest = json.loads(ranking_manifest_path.read_text())
    label_manifest, label_path = _verified_dataset(
        label_dataset_root,
        "label-dataset.v2",
    )
    bundle = QuantModelBundle(quant_model_root, require_ready=False)
    if (
        coverage_audit["lineage"]["rankingDatabaseSha256"]
        != ranking_manifest["databaseSha256"]
        or coverage_audit["lineage"]["labelDatabaseSha256"]
        != label_manifest["databaseSha256"]
        or bundle.manifest.get("rankingDatabaseSha256")
        != ranking_manifest["databaseSha256"]
        or bundle.base_feature_names != ENRICHED_BASE_FEATURE_NAMES
        or bundle.scenario_feature_names != ENRICHED_SCENARIO_FEATURE_NAMES
    ):
        raise QuantModelError("BACKTEST_MODEL_LINEAGE_MISMATCH")

    database = sqlite3.connect(
        f"{label_path.resolve().as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    database.row_factory = sqlite3.Row
    ranking_path = ranking_dataset_root.resolve() / ranking_manifest["database"]
    database.execute(
        "ATTACH DATABASE ? AS ranking",
        (f"{ranking_path.resolve().as_uri()}?mode=ro&immutable=1",),
    )
    label_rows = _preferred_label_rows(database)
    ranking_features = _selected_ranking_features(
        database,
        expected_count=len(label_rows),
    )
    base = np.asarray(
        [
            ranking_features[(row["decision_date"], row["instrument_id"])]
            for row in label_rows
        ],
        dtype=np.float32,
    )
    scenario = np.column_stack(
        (
            base,
            np.log1p(
                np.asarray(
                    [float(row["target_notional_cny"]) for row in label_rows]
                )
            ),
            np.log1p(
                np.asarray([row["target_shares"] for row in label_rows])
            ),
            np.log(
                np.maximum(
                    np.asarray(
                        [float(row["target_to_median_amount"]) for row in label_rows]
                    ),
                    1e-12,
                )
            ),
        )
    ).astype(np.float32)
    predictions = bundle.predict_matrix(
        base_values=base,
        scenario_values=scenario,
    )
    database.close()

    coverage_rows = {
        (row["decisionDate"], row["instrumentId"]): row
        for row in coverage_audit["selections"]
    }
    rows = []
    for index, label in enumerate(label_rows):
        key = (label["decision_date"], label["instrument_id"])
        coverage = coverage_rows.get(key)
        if not coverage or coverage["coverageStatus"] != "COVERED":
            raise QuantModelError("BACKTEST_LABEL_COVERAGE_MISMATCH")
        fill_ratio = float(label["fill_ratio"])
        net_return = (
            float(label["net_return_given_fill"])
            if label["net_return_given_fill"] is not None
            else None
        )
        actual = (net_return or 0.0) * fill_ratio
        stressed = (
            ((net_return or 0.0) - STRESS_COST) * fill_ratio
            if label["p_fill_label"]
            else 0.0
        )
        predicted_utility = float(predictions["pFill"][index]) * (
            float(predictions["expectedNetReturnGivenFill"][index]) - STRESS_COST
        )
        rows.append(
            {
                "decisionDate": label["decision_date"],
                "instrumentId": label["instrument_id"],
                "board": label["board"],
                "rankPosition": coverage["rankPosition"],
                "targetShares": label["target_shares"],
                "targetNotionalCny": label["target_notional_cny"],
                "fillRatio": fill_ratio,
                "pFillLabel": label["p_fill_label"],
                "pFullFillLabel": label["p_full_fill_label"],
                "netReturnGivenFill": net_return,
                "exitReason": label["exit_reason"],
                "actualReturnOnRequestedCapital": actual,
                "actualReturnAt10BpsStress": stressed,
                "predictedUtilityAt10BpsStress": predicted_utility,
                "modelActionable": predicted_utility > 0,
                **{
                    name: float(values[index])
                    for name, values in predictions.items()
                },
            }
        )
    if len(rows) != coverage_audit["coverage"]["covered"]:
        raise QuantModelError("BACKTEST_LABEL_COUNT_MISMATCH")

    actionable = [row for row in rows if row["modelActionable"]]
    actionable_metrics = _cohort_metrics(actionable)
    by_board = {
        board: _cohort_metrics(
            [row for row in actionable if row["board"] == board]
        )
        for board in ("MAIN", "CHINEXT", "STAR", "BEIJING")
    }
    by_year = {
        year: _cohort_metrics(
            [row for row in actionable if row["decisionDate"].startswith(year)]
        )
        for year in sorted({row["decisionDate"][:4] for row in rows})
    }
    quintiles = _quantile_diagnostics(rows)
    quintile_returns = [
        row["meanReturnAt10BpsStress"]
        for row in quintiles
        if row["meanReturnAt10BpsStress"] is not None
    ]
    utility_monotonic = _is_non_decreasing(quintile_returns)
    blockers = [
        "ACCOUNT_CAPITAL_REPLAY_PENDING",
        "AGENT_BUNDLE_MISSING",
        "JOINT_ABLATION_PENDING",
    ]
    if not coverage_audit["complete"]:
        blockers.insert(0, "SELECTED_MINUTE_EXECUTION_COVERAGE_INCOMPLETE")
    if (
        actionable_metrics["meanReturnAt10BpsStress"] is None
        or actionable_metrics["meanReturnAt10BpsStress"] <= 0
    ):
        blockers.insert(0, "STRESS_NET_RETURN_NOT_POSITIVE")
    if any(metrics["selections"] == 0 for metrics in by_board.values()):
        blockers.insert(0, "BOARD_ACTION_COVERAGE_INCOMPLETE")
    if any(
        metrics["meanReturnAt10BpsStress"] is not None
        and metrics["meanReturnAt10BpsStress"] <= 0
        for metrics in by_board.values()
    ):
        blockers.insert(0, "BOARD_STRESS_RETURN_NOT_POSITIVE")
    if any(
        metrics["meanReturnAt10BpsStress"] is not None
        and metrics["meanReturnAt10BpsStress"] <= 0
        for metrics in by_year.values()
    ):
        blockers.insert(0, "PERIOD_STRESS_RETURN_NOT_POSITIVE")
    if not utility_monotonic:
        blockers.insert(0, "PREDICTED_UTILITY_MONOTONICITY_FAILED")
    report = {
        "schemaVersion": BACKTEST_SCHEMA_VERSION,
        "createdAt": datetime.now(UTC).isoformat(),
        "evaluationTarget": "INDEPENDENT_EPISODE_RETURN_NOT_ACCOUNT_EQUITY",
        "releaseStatus": "UNAVAILABLE",
        "releaseBlockers": blockers,
        "policy": {
            "candidateSelection": coverage_audit["selectionPolicy"],
            "modelGate": "pFill*(expectedNetReturnGivenFill-0.001)>0",
            "stressCostBps": 10,
            "unavailablePathTreatment": "EXCLUDED_AND_REPORTED_NOT_ZERO_FILLED",
        },
        "lineage": {
            **coverage_audit["lineage"],
            "coverageAuditSha256": _file_sha256(coverage_audit_path),
            "quantModelBundleId": bundle.manifest["bundleId"],
            "quantModelArtifactSha256": bundle.manifest["artifactSha256"],
        },
        "coverage": coverage_audit["coverage"],
        "rankingOnlyCovered": _cohort_metrics(rows),
        "modelActionable": actionable_metrics,
        "modelActionableByBoard": by_board,
        "modelActionableByYear": by_year,
        "predictedUtilityMonotonic": utility_monotonic,
        "predictedUtilityQuintiles": quintiles,
        "rows": rows,
    }
    if any(
        isinstance(value, float) and not math.isfinite(value)
        for row in rows
        for value in row.values()
    ):
        raise QuantModelError("BACKTEST_RESULT_NON_FINITE")
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    os.replace(temporary, output_path)
    return report
