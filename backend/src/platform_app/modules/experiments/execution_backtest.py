"""Causal out-of-time selection and execution coverage audit."""

import hashlib
import json
import os
import sqlite3
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from platform_app.modules.experiments.quant_model_trainer import (
    QuantModelError,
    TemporalSplit,
    temporal_split,
)
from platform_app.modules.experiments.ranking_model_bundle import (
    RankingModelBundle,
)
from platform_app.modules.experiments.ranking_model_trainer import (
    RankingTrainingData,
    load_ranking_training_data,
)

BOARD_NAMES = ("MAIN", "CHINEXT", "STAR", "BEIJING")
COVERAGE_SCHEMA_VERSION = "execution-coverage-audit.v1"


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _verified_dataset(root: Path, expected_schema: str) -> tuple[dict, Path]:
    manifest_path = root.resolve() / "manifest.json"
    if not manifest_path.is_file():
        raise QuantModelError("BACKTEST_INPUT_NOT_SEALED")
    try:
        manifest = json.loads(manifest_path.read_text())
        database = root.resolve() / manifest["database"]
    except (KeyError, json.JSONDecodeError, TypeError) as exc:
        raise QuantModelError("BACKTEST_INPUT_MANIFEST_INVALID") from exc
    if (
        manifest.get("schemaVersion") != expected_schema
        or not database.is_file()
        or _file_sha256(database) != manifest.get("databaseSha256")
    ):
        raise QuantModelError("BACKTEST_INPUT_HASH_MISMATCH")
    return manifest, database


def select_confirmation_candidates(
    data: RankingTrainingData,
    bundle: RankingModelBundle,
    *,
    top_n: int = 10,
) -> tuple[list[dict], TemporalSplit]:
    if top_n <= 0:
        raise QuantModelError("BACKTEST_SELECTION_COUNT_INVALID")
    split = temporal_split(data.dates)
    confirmation = split.masks(data.dates)[2]
    row_indexes = np.flatnonzero(confirmation)
    predictions = bundle.predict_matrix(data.x[confirmation])
    rank_scores = predictions["rankScore"]
    expected_returns = predictions["expectedGrossReturn"]
    if len(rank_scores) != len(row_indexes) or len(expected_returns) != len(row_indexes):
        raise QuantModelError("BACKTEST_PREDICTION_COUNT_MISMATCH")

    selections = []
    confirmation_dates = data.dates[confirmation]
    for decision_date in np.unique(confirmation_dates):
        date_positions = np.flatnonzero(confirmation_dates == decision_date)
        date_scores = rank_scores[date_positions]
        date_instruments = data.instruments[row_indexes[date_positions]]
        order = np.lexsort((date_instruments, -date_scores))[:top_n]
        for rank_position, local_position in enumerate(order, start=1):
            prediction_position = date_positions[local_position]
            source_index = row_indexes[prediction_position]
            selections.append(
                {
                    "decisionDate": str(int(decision_date)),
                    "instrumentId": data.instruments[source_index].decode(),
                    "board": BOARD_NAMES[int(data.boards[source_index])],
                    "rankPosition": rank_position,
                    "rankScore": float(rank_scores[prediction_position]),
                    "expectedGrossReturn": float(
                        expected_returns[prediction_position]
                    ),
                    "universeSize": int(len(date_positions)),
                }
            )
    return selections, split


def _load_execution_matches(
    selections: list[dict],
    *,
    episode_database: Path,
    label_database: Path,
) -> list[dict]:
    database = sqlite3.connect(":memory:", uri=True)
    database.row_factory = sqlite3.Row
    database.execute(
        "CREATE TABLE selected ("
        "decision_date TEXT NOT NULL, instrument_id TEXT NOT NULL, board TEXT NOT NULL, "
        "rank_position INTEGER NOT NULL, rank_score REAL NOT NULL, "
        "expected_gross_return REAL NOT NULL, universe_size INTEGER NOT NULL, "
        "PRIMARY KEY (decision_date, instrument_id))"
    )
    database.executemany(
        "INSERT INTO selected VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            (
                row["decisionDate"],
                row["instrumentId"],
                row["board"],
                row["rankPosition"],
                row["rankScore"],
                row["expectedGrossReturn"],
                row["universeSize"],
            )
            for row in selections
        ],
    )
    database.execute(
        "ATTACH DATABASE ? AS episodes",
        (f"{episode_database.resolve().as_uri()}?mode=ro&immutable=1",),
    )
    database.execute(
        "ATTACH DATABASE ? AS labels",
        (f"{label_database.resolve().as_uri()}?mode=ro&immutable=1",),
    )
    rows = database.execute(
        "WITH preferred_labels AS ("
        "SELECT l.*, ROW_NUMBER() OVER ("
        "PARTITION BY l.decision_date, l.instrument_id "
        "ORDER BY l.reference_100k DESC, "
        "ABS(CAST(l.target_notional_cny AS REAL) - 100000), l.target_shares"
        ") AS scenario_rank "
        "FROM labels.episode_labels l JOIN selected s "
        "ON s.decision_date = l.decision_date "
        "AND s.instrument_id = l.instrument_id"
        ") "
        "SELECT s.*, e.episode_id, l.reference_100k, l.target_notional_cny, "
        "l.target_shares, l.filled_shares, l.fill_ratio, l.p_fill_label, "
        "l.p_full_fill_label, l.net_return_given_fill, l.exit_reason "
        "FROM selected s LEFT JOIN episodes.candidate_episodes e "
        "ON e.decision_date = s.decision_date "
        "AND e.instrument_id = s.instrument_id "
        "LEFT JOIN preferred_labels l "
        "ON l.decision_date = s.decision_date "
        "AND l.instrument_id = s.instrument_id AND l.scenario_rank = 1 "
        "ORDER BY s.decision_date, s.rank_position"
    ).fetchall()
    database.close()
    matches = []
    for row in rows:
        if row["target_shares"] is not None:
            status = "COVERED"
        elif row["episode_id"] is not None:
            status = "MINUTE_PATH_UNAVAILABLE"
        else:
            status = "NOT_IN_LEGACY_MINUTE_UNIVERSE"
        net_return = (
            float(row["net_return_given_fill"])
            if row["net_return_given_fill"] is not None
            else None
        )
        fill_ratio = float(row["fill_ratio"]) if row["fill_ratio"] is not None else None
        matches.append(
            {
                "decisionDate": row["decision_date"],
                "instrumentId": row["instrument_id"],
                "board": row["board"],
                "rankPosition": row["rank_position"],
                "rankScore": row["rank_score"],
                "expectedGrossReturn": row["expected_gross_return"],
                "universeSize": row["universe_size"],
                "coverageStatus": status,
                "reference100k": (
                    bool(row["reference_100k"])
                    if row["reference_100k"] is not None
                    else None
                ),
                "targetNotionalCny": row["target_notional_cny"],
                "targetShares": row["target_shares"],
                "filledShares": row["filled_shares"],
                "fillRatio": fill_ratio,
                "pFillLabel": row["p_fill_label"],
                "pFullFillLabel": row["p_full_fill_label"],
                "netReturnGivenFill": net_return,
                "exitReason": row["exit_reason"],
                "returnOnRequestedCapital": (
                    (net_return or 0.0) * fill_ratio
                    if fill_ratio is not None
                    else None
                ),
                "returnAt10BpsStress": (
                    ((net_return or 0.0) - 0.001) * fill_ratio
                    if fill_ratio is not None and row["p_fill_label"]
                    else (0.0 if fill_ratio is not None else None)
                ),
            }
        )
    return matches


def _coverage_summary(matches: list[dict]) -> dict:
    status_counts = Counter(row["coverageStatus"] for row in matches)
    selected_dates = {row["decisionDate"] for row in matches}
    covered_dates = {
        decision_date
        for decision_date in selected_dates
        if all(
            row["coverageStatus"] == "COVERED"
            for row in matches
            if row["decisionDate"] == decision_date
        )
    }
    by_board = {}
    for board in BOARD_NAMES:
        rows = [row for row in matches if row["board"] == board]
        counts = Counter(row["coverageStatus"] for row in rows)
        by_board[board] = {
            "selected": len(rows),
            "covered": counts["COVERED"],
            "minutePathUnavailable": counts["MINUTE_PATH_UNAVAILABLE"],
            "notInLegacyMinuteUniverse": counts[
                "NOT_IN_LEGACY_MINUTE_UNIVERSE"
            ],
        }
    covered = [row for row in matches if row["coverageStatus"] == "COVERED"]
    returns = np.asarray(
        [row["returnOnRequestedCapital"] for row in covered],
        dtype=np.float64,
    )
    stressed = np.asarray(
        [row["returnAt10BpsStress"] for row in covered],
        dtype=np.float64,
    )
    return {
        "selected": len(matches),
        "dates": len(selected_dates),
        "covered": status_counts["COVERED"],
        "coverageRate": status_counts["COVERED"] / len(matches) if matches else 0.0,
        "fullyCoveredDates": len(covered_dates),
        "minutePathUnavailable": status_counts["MINUTE_PATH_UNAVAILABLE"],
        "notInLegacyMinuteUniverse": status_counts[
            "NOT_IN_LEGACY_MINUTE_UNIVERSE"
        ],
        "byBoard": by_board,
        "coveredOnlyDiagnostic": {
            "filled": sum(bool(row["pFillLabel"]) for row in covered),
            "meanReturnOnRequestedCapital": (
                float(np.mean(returns)) if len(returns) else None
            ),
            "meanReturnAt10BpsStress": (
                float(np.mean(stressed)) if len(stressed) else None
            ),
        },
    }


def write_execution_coverage_audit(
    *,
    ranking_dataset_root: Path,
    ranking_model_root: Path,
    episode_dataset_root: Path,
    label_dataset_root: Path,
    output_path: Path,
    top_n: int = 10,
) -> dict:
    data, ranking_manifest = load_ranking_training_data(ranking_dataset_root)
    bundle = RankingModelBundle(ranking_model_root, require_ready=False)
    if (
        bundle.manifest.get("rankingDatabaseSha256")
        != ranking_manifest["databaseSha256"]
    ):
        raise QuantModelError("BACKTEST_RANKING_LINEAGE_MISMATCH")
    episode_manifest, episode_database = _verified_dataset(
        episode_dataset_root,
        "episode-dataset.v4",
    )
    label_manifest, label_database = _verified_dataset(
        label_dataset_root,
        "label-dataset.v2",
    )
    if (
        label_manifest.get("episodeDatabaseSha256")
        != episode_manifest["databaseSha256"]
        or ranking_manifest.get("marketDatabaseSha256")
        != episode_manifest["marketDatabaseSha256"]
    ):
        raise QuantModelError("BACKTEST_EXECUTION_LINEAGE_MISMATCH")
    selections, split = select_confirmation_candidates(data, bundle, top_n=top_n)
    matches = _load_execution_matches(
        selections,
        episode_database=episode_database,
        label_database=label_database,
    )
    summary = _coverage_summary(matches)
    complete = summary["covered"] == summary["selected"]
    report = {
        "schemaVersion": COVERAGE_SCHEMA_VERSION,
        "createdAt": datetime.now(UTC).isoformat(),
        "selectionPolicy": {
            "universe": "ALL_POINT_IN_TIME_LISTED_A_SHARES",
            "confirmationOnly": True,
            "dailyTopN": top_n,
            "tieBreak": "INSTRUMENT_ID_ASC",
            "orderSize": "REFERENCE_100K_ELSE_CLOSEST_VALID_BOARD_LOT",
            "stressCostBps": 10,
        },
        "split": split.as_dict(),
        "lineage": {
            "rankingDatasetId": ranking_manifest["datasetId"],
            "rankingDatabaseSha256": ranking_manifest["databaseSha256"],
            "rankingModelBundleId": bundle.manifest["bundleId"],
            "rankingModelArtifactSha256": bundle.manifest["artifactSha256"],
            "episodeDatasetId": episode_manifest["datasetId"],
            "episodeDatabaseSha256": episode_manifest["databaseSha256"],
            "labelDatasetId": label_manifest["datasetId"],
            "labelDatabaseSha256": label_manifest["databaseSha256"],
        },
        "coverage": summary,
        "complete": complete,
        "releaseBlockers": (
            [] if complete else ["SELECTED_MINUTE_EXECUTION_COVERAGE_INCOMPLETE"]
        ),
        "selections": matches,
    }
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )
    os.replace(temporary, output_path)
    return report
