"""Build execution episodes from full-universe model selections."""

import copy
import json
import sqlite3
from collections import Counter
from pathlib import Path

from platform_app.modules.experiments.episode_dataset import (
    EpisodeDataset,
    EpisodeDatasetError,
    canonical_sha256,
)
from platform_app.modules.experiments.daily_ranking_sample import (
    FEATURE_SCHEMA_VERSION,
)
from platform_app.modules.experiments.execution_backtest import (
    select_confirmation_candidates,
)
from platform_app.modules.experiments.ranking_dataset import FEATURE_COLUMNS
from platform_app.modules.experiments.ranking_model_bundle import RankingModelBundle
from platform_app.modules.experiments.ranking_model_trainer import (
    RAW_COLUMNS,
    load_ranking_training_data,
)
from platform_app.modules.experiments.short_horizon_policy import (
    SHORT_HORIZON_POLICY,
)

SAMPLE_BUCKET = "FULL_UNIVERSE_MODEL_TOP"


def selected_backtest_policy(
    *,
    ranking_manifest: dict,
    ranking_model_manifest: dict,
    top_n: int,
) -> dict:
    if (
        top_n <= 0
        or ranking_model_manifest.get("rankingDatabaseSha256")
        != ranking_manifest.get("databaseSha256")
    ):
        raise EpisodeDatasetError("SELECTED_BACKTEST_LINEAGE_INVALID")
    policy = copy.deepcopy(SHORT_HORIZON_POLICY)
    policy.update(
        {
            "policyVersion": "full-universe-selected-backtest.v1",
            "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
            "candidatePolicy": {
                "decisionTimeShanghai": "AFTER_DAILY_FEATURE_AVAILABLE",
                "universe": "ALL_POINT_IN_TIME_MODEL_ELIGIBLE_A_SHARES",
                "selection": "DAILY_FULL_UNIVERSE_RANK_MODEL_TOP_N",
                "dailyTopN": top_n,
                "tieBreak": "INSTRUMENT_ID_ASC",
                "confirmationOnly": True,
                "rankingDatasetId": ranking_manifest["datasetId"],
                "rankingDatabaseSha256": ranking_manifest["databaseSha256"],
                "rankingModelBundleId": ranking_model_manifest["bundleId"],
                "rankingModelArtifactSha256": ranking_model_manifest[
                    "artifactSha256"
                ],
            },
        }
    )
    return policy


def load_selected_backtest_policy(
    *,
    ranking_dataset_root: Path,
    ranking_model_root: Path,
    top_n: int,
) -> dict:
    manifest_path = ranking_dataset_root.resolve() / "manifest.json"
    if not manifest_path.is_file():
        raise EpisodeDatasetError("SELECTED_RANKING_DATASET_NOT_SEALED")
    ranking_manifest = json.loads(manifest_path.read_text())
    bundle = RankingModelBundle(ranking_model_root, require_ready=False)
    return selected_backtest_policy(
        ranking_manifest=ranking_manifest,
        ranking_model_manifest=bundle.manifest,
        top_n=top_n,
    )


def _partition_payload(
    *,
    decision_date: str,
    selections: list[dict],
    universe_rows: list[dict],
    feature_schema_version: str,
) -> dict:
    selected = {row["instrumentId"]: row for row in selections}
    universe = [
        {"instrumentId": row["instrument_id"], "board": row["board"]}
        for row in universe_rows
    ]
    selected_rows = [
        row for row in universe_rows if row["instrument_id"] in selected
    ]
    if len(selected_rows) != len(selected):
        raise EpisodeDatasetError("SELECTED_CANDIDATE_MISSING_FROM_RANKING_DATASET")
    execution_dates = {row["execution_date"] for row in selected_rows}
    if len(execution_dates) != 1:
        raise EpisodeDatasetError("SELECTED_CANDIDATE_EXECUTION_DATE_INVALID")

    board_ranks = Counter()
    candidates = []
    for row in sorted(
        selected_rows,
        key=lambda item: selected[item["instrument_id"]]["rankPosition"],
    ):
        selection = selected[row["instrument_id"]]
        board_ranks[row["board"]] += 1
        features = {
            feature_name: row[column]
            for feature_name, column in zip(
                FEATURE_COLUMNS,
                RAW_COLUMNS,
                strict=True,
            )
        }
        candidates.append(
            {
                "instrumentId": row["instrument_id"],
                "board": row["board"],
                "rankWithinBoard": board_ranks[row["board"]],
                "sampleBucket": SAMPLE_BUCKET,
                "featureAvailableAt": row["feature_available_at"],
                "featureSchemaVersion": feature_schema_version,
                "features": features,
                "selectionScore": format(selection["rankScore"], ".17g"),
            }
        )
    universe_by_board = Counter(row["board"] for row in universe_rows)
    selected_by_board = Counter(row["board"] for row in selected_rows)
    return {
        "decision_date": decision_date,
        "execution_date": execution_dates.pop(),
        "universe_count": len(universe),
        "universe_sha256": canonical_sha256(universe),
        "candidates": candidates,
        "rejections": [
            {
                "board": board,
                "reason": "NOT_SELECTED_BY_MODEL_TOP_N",
                "instrumentCount": count - selected_by_board[board],
            }
            for board, count in sorted(universe_by_board.items())
            if count > selected_by_board[board]
        ],
    }


class SelectedEpisodeBuilder:
    def __init__(
        self,
        dataset: EpisodeDataset,
        *,
        ranking_dataset_root: Path,
        ranking_model_root: Path,
        top_n: int,
    ):
        self.dataset = dataset
        self.ranking_dataset_root = ranking_dataset_root.resolve()
        self.bundle = RankingModelBundle(ranking_model_root, require_ready=False)
        self.top_n = top_n

    def build_range(self, start_date: str, end_date: str):
        data, ranking_manifest = load_ranking_training_data(
            self.ranking_dataset_root
        )
        expected_policy = selected_backtest_policy(
            ranking_manifest=ranking_manifest,
            ranking_model_manifest=self.bundle.manifest,
            top_n=self.top_n,
        )
        actual_policy = json.loads(
            self.dataset.db.execute(
                "SELECT policy_json FROM episode_dataset_metadata"
            ).fetchone()[0]
        )
        if actual_policy != expected_policy:
            raise EpisodeDatasetError("SELECTED_BACKTEST_POLICY_MISMATCH")
        selections, _split = select_confirmation_candidates(
            data,
            self.bundle,
            top_n=self.top_n,
        )
        by_date: dict[str, list[dict]] = {}
        for row in selections:
            if start_date <= row["decisionDate"] <= end_date:
                by_date.setdefault(row["decisionDate"], []).append(row)

        ranking_path = self.ranking_dataset_root / ranking_manifest["database"]
        database = sqlite3.connect(
            f"{ranking_path.as_uri()}?mode=ro&immutable=1",
            uri=True,
        )
        database.row_factory = sqlite3.Row
        columns = ", ".join(
            (
                "instrument_id",
                "board",
                "execution_date",
                "feature_available_at",
                *RAW_COLUMNS,
            )
        )
        for decision_date, date_selections in sorted(by_date.items()):
            if self.dataset.has_candidate_partition(decision_date):
                yield {"decisionDate": decision_date, "status": "SKIPPED"}
                continue
            rows = [
                dict(row)
                for row in database.execute(
                    f"SELECT {columns} FROM ranking_samples "
                    "WHERE decision_date = ? ORDER BY instrument_id",
                    (decision_date,),
                )
            ]
            payload = _partition_payload(
                decision_date=decision_date,
                selections=date_selections,
                universe_rows=rows,
                feature_schema_version=expected_policy["featureSchemaVersion"],
            )
            self.dataset.write_candidate_partition(**payload)
            yield {
                "decisionDate": decision_date,
                "status": "COMPLETED",
                "universeCount": payload["universe_count"],
                "candidateCount": len(payload["candidates"]),
            }
        database.close()
