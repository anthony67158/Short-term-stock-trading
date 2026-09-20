"""Shared training-data contract for fee-after execution action value models."""

from collections import Counter, defaultdict, deque
from dataclasses import dataclass, replace
from decimal import Decimal, InvalidOperation
import math
from pathlib import Path
from typing import Iterable, Mapping

import numpy as np


class ActionValueTrainingError(ValueError):
    pass


FEATURE_SETS = (
    "technical",
    "factor",
    "fusion",
    "technical_history",
    "fusion_history",
)
SCENARIO_FEATURE_SUFFIX = (
    "logTargetNotionalCny",
    "logTargetShares",
    "logTargetToMedianAmount",
)
HISTORICAL_EXECUTION_FEATURE_NAMES = (
    "executionHistoryCount",
    "historicalAnyFillRate",
    "historicalFillFraction",
    "historicalFullFillRate",
    "historicalWinRate",
    "historicalStopRate",
    "historicalRequestedReturnMean",
    "executionHistoryMissing",
)


@dataclass(frozen=True)
class ActionValueTrainingData:
    features: np.ndarray
    feature_names: tuple[str, ...]
    dates: np.ndarray
    episodes: np.ndarray
    boards: np.ndarray
    weights: np.ndarray
    p_any_fill: np.ndarray
    fill_fraction: np.ndarray
    p_full_fill: np.ndarray
    p_win_given_fill: np.ndarray
    stop_hazard_given_fill: np.ndarray
    conditional_return: np.ndarray
    net_return_on_requested_notional: np.ndarray
    conditional_available: np.ndarray


def scenario_weights(dates, episodes) -> np.ndarray:
    """Give every date unit weight and split each episode across its scenarios."""
    dates = np.asarray(dates)
    episodes = np.asarray(episodes, dtype=str)
    if dates.ndim != 1 or episodes.ndim != 1 or len(dates) != len(episodes):
        raise ActionValueTrainingError("ACTION_VALUE_WEIGHT_ALIGNMENT_INVALID")
    if not len(dates):
        raise ActionValueTrainingError("ACTION_VALUE_SAMPLE_EMPTY")

    episode_counts = Counter(zip(dates.tolist(), episodes.tolist(), strict=True))
    weights = np.asarray(
        [
            1.0 / episode_counts[(date, episode)]
            for date, episode in zip(dates.tolist(), episodes.tolist(), strict=True)
        ],
        dtype=np.float64,
    )
    totals = defaultdict(float)
    for date, weight in zip(dates.tolist(), weights, strict=True):
        totals[date] += float(weight)
    weights /= np.asarray([totals[date] for date in dates.tolist()])
    return weights


def requested_notional_return(row: Mapping) -> float:
    """Return realized fee-after PnL divided by requested, not filled, capital."""
    try:
        filled_shares = Decimal(row["filled_shares"])
        if filled_shares == 0:
            return 0.0
        target_notional = Decimal(row["target_notional_cny"])
        if filled_shares < 0 or target_notional <= 0:
            raise ActionValueTrainingError("ACTION_VALUE_RETURN_INVALID")
        pnl = (
            (Decimal(row["exit_price"]) - Decimal(row["entry_price"]))
            * filled_shares
            - Decimal(row["buy_fees_cny"])
            - Decimal(row["sell_fees_cny"])
        )
        value = float(pnl / target_notional)
    except (InvalidOperation, KeyError, TypeError, ValueError) as exc:
        raise ActionValueTrainingError("ACTION_VALUE_RETURN_INVALID") from exc
    if not np.isfinite(value):
        raise ActionValueTrainingError("ACTION_VALUE_RETURN_INVALID")
    return value


def build_action_value_training_data(
    *,
    features,
    feature_names,
    dates,
    boards,
    rows: Iterable[Mapping],
) -> ActionValueTrainingData:
    rows = list(rows)
    features = np.asarray(features, dtype=np.float32)
    feature_names = tuple(feature_names)
    dates = np.asarray(dates)
    boards = np.asarray(boards)
    sample_count = len(rows)

    if (
        features.ndim != 2
        or len(features) != sample_count
        or dates.ndim != 1
        or boards.ndim != 1
        or len(dates) != sample_count
        or len(boards) != sample_count
    ):
        raise ActionValueTrainingError("ACTION_VALUE_ROW_COUNT_MISMATCH")
    if (
        not feature_names
        or len(set(feature_names)) != len(feature_names)
        or features.shape[1] != len(feature_names)
    ):
        raise ActionValueTrainingError("ACTION_VALUE_FEATURE_CONTRACT_INVALID")
    if not np.all(np.isfinite(features)):
        raise ActionValueTrainingError("ACTION_VALUE_FEATURE_NON_FINITE")

    row_dates = np.asarray([int(row["decision_date"]) for row in rows])
    if not np.array_equal(dates, row_dates):
        raise ActionValueTrainingError("ACTION_VALUE_DATE_ALIGNMENT_INVALID")

    episodes = np.asarray([str(row["episode_id"]) for row in rows])
    fill_fraction = np.asarray([float(row["fill_ratio"]) for row in rows])
    p_any_fill = np.asarray([int(row["p_fill_label"]) for row in rows], dtype=np.int8)
    p_full_fill = np.asarray(
        [int(row["p_full_fill_label"]) for row in rows],
        dtype=np.int8,
    )
    conditional_available = np.asarray(
        [row["net_return_given_fill"] is not None for row in rows],
        dtype=bool,
    )
    p_win_available = np.asarray(
        [row["p_win_given_fill_label"] is not None for row in rows],
        dtype=bool,
    )
    p_win_given_fill = np.asarray(
        [
            int(row["p_win_given_fill_label"]) if available else 0
            for row, available in zip(rows, p_win_available, strict=True)
        ],
        dtype=np.int8,
    )
    stop_hazard_available = np.asarray(
        [row["stop_hazard_label"] is not None for row in rows],
        dtype=bool,
    )
    stop_hazard_given_fill = np.asarray(
        [
            int(row["stop_hazard_label"]) if available else 0
            for row, available in zip(rows, stop_hazard_available, strict=True)
        ],
        dtype=np.int8,
    )
    conditional_return = np.asarray(
        [
            float(row["net_return_given_fill"]) if available else 0.0
            for row, available in zip(rows, conditional_available, strict=True)
        ],
        dtype=np.float64,
    )
    requested_return = np.asarray(
        [requested_notional_return(row) for row in rows],
        dtype=np.float64,
    )

    if (
        not np.all(np.isfinite(fill_fraction))
        or not np.all(np.isfinite(conditional_return))
        or np.any((fill_fraction < 0) | (fill_fraction > 1))
        or np.any(~np.isin(p_any_fill, (0, 1)))
        or np.any(~np.isin(p_full_fill, (0, 1)))
        or np.any(~np.isin(p_win_given_fill, (0, 1)))
        or np.any(~np.isin(stop_hazard_given_fill, (0, 1)))
        or np.any(p_any_fill != (fill_fraction > 0))
        or np.any(p_full_fill > p_any_fill)
        or np.any(p_full_fill != np.isclose(fill_fraction, 1))
        or np.any(conditional_available != (p_any_fill == 1))
        or np.any(p_win_available != conditional_available)
        or np.any(stop_hazard_available != conditional_available)
        or np.any(
            p_win_given_fill[conditional_available]
            != (conditional_return[conditional_available] > 0)
        )
        or np.any(requested_return[~conditional_available] != 0)
    ):
        raise ActionValueTrainingError("ACTION_VALUE_HURDLE_LABEL_INVALID")

    return ActionValueTrainingData(
        features=features,
        feature_names=feature_names,
        dates=dates.astype(np.int32, copy=False),
        episodes=episodes,
        boards=boards.astype(np.int8, copy=False),
        weights=scenario_weights(dates, episodes),
        p_any_fill=p_any_fill,
        fill_fraction=fill_fraction,
        p_full_fill=p_full_fill,
        p_win_given_fill=p_win_given_fill,
        stop_hazard_given_fill=stop_hazard_given_fill,
        conditional_return=conditional_return,
        net_return_on_requested_notional=requested_return,
        conditional_available=conditional_available,
    )


def with_multifactor_features(
    data: ActionValueTrainingData,
    *,
    factor_vectors: Mapping[str, Iterable[float]],
    factor_feature_names: Iterable[str],
    feature_set: str,
) -> ActionValueTrainingData:
    if feature_set not in {"technical", "factor", "fusion"}:
        raise ActionValueTrainingError("ACTION_VALUE_FEATURE_SET_INVALID")
    if feature_set == "technical":
        return data
    factor_feature_names = tuple(factor_feature_names)
    if (
        not factor_feature_names
        or len(set(factor_feature_names)) != len(factor_feature_names)
        or data.feature_names[-len(SCENARIO_FEATURE_SUFFIX) :]
        != SCENARIO_FEATURE_SUFFIX
    ):
        raise ActionValueTrainingError(
            "ACTION_VALUE_FACTOR_FEATURE_CONTRACT_INVALID"
        )
    try:
        factors = np.asarray(
            [factor_vectors[episode] for episode in data.episodes],
            dtype=np.float32,
        )
    except KeyError as exc:
        raise ActionValueTrainingError(
            "ACTION_VALUE_FACTOR_COVERAGE_INCOMPLETE"
        ) from exc
    if (
        factors.shape != (len(data.features), len(factor_feature_names))
        or not np.all(np.isfinite(factors))
    ):
        raise ActionValueTrainingError(
            "ACTION_VALUE_FACTOR_FEATURE_CONTRACT_INVALID"
        )
    scenario = data.features[:, -len(SCENARIO_FEATURE_SUFFIX) :]
    if feature_set == "factor":
        features = np.column_stack((factors, scenario))
        feature_names = (*factor_feature_names, *SCENARIO_FEATURE_SUFFIX)
    else:
        technical = data.features[:, : -len(SCENARIO_FEATURE_SUFFIX)]
        features = np.column_stack((technical, factors, scenario))
        feature_names = (
            *data.feature_names[: -len(SCENARIO_FEATURE_SUFFIX)],
            *factor_feature_names,
            *SCENARIO_FEATURE_SUFFIX,
        )
    return replace(
        data,
        features=np.asarray(features, dtype=np.float32),
        feature_names=feature_names,
    )


def historical_execution_feature_matrix(
    rows: Iterable[Mapping],
    *,
    maturity_dates: Mapping[str, str],
    window: int = 20,
) -> np.ndarray:
    rows = list(rows)
    if window <= 0:
        raise ActionValueTrainingError(
            "ACTION_VALUE_HISTORY_WINDOW_INVALID"
        )
    by_episode: dict[str, list[Mapping]] = defaultdict(list)
    indexes_by_date: dict[int, list[int]] = defaultdict(list)
    for index, row in enumerate(rows):
        episode = str(row["episode_id"])
        by_episode[episode].append(row)
        indexes_by_date[int(row["decision_date"])].append(index)
    if set(by_episode) != set(maturity_dates):
        raise ActionValueTrainingError(
            "ACTION_VALUE_HISTORY_MATURITY_COVERAGE_INVALID"
        )

    events = []
    for episode, episode_rows in by_episode.items():
        first = episode_rows[0]
        conditional = [
            row for row in episode_rows
            if row["net_return_given_fill"] is not None
        ]
        events.append(
            (
                int(maturity_dates[episode]),
                int(first["decision_date"]),
                episode,
                str(first["instrument_id"]),
                (
                    float(np.mean([
                        int(row["p_fill_label"]) for row in episode_rows
                    ])),
                    float(np.mean([
                        float(row["fill_ratio"]) for row in episode_rows
                    ])),
                    float(np.mean([
                        int(row["p_full_fill_label"]) for row in episode_rows
                    ])),
                    (
                        float(np.mean([
                            int(row["p_win_given_fill_label"])
                            for row in conditional
                        ]))
                        if conditional
                        else None
                    ),
                    (
                        float(np.mean([
                            int(row["stop_hazard_label"])
                            for row in conditional
                        ]))
                        if conditional
                        else None
                    ),
                    float(np.mean([
                        requested_notional_return(row)
                        for row in episode_rows
                    ])),
                ),
            )
        )
    events.sort(key=lambda item: (item[0], item[1], item[2]))
    history: dict[str, deque] = defaultdict(lambda: deque(maxlen=window))
    features = np.empty(
        (len(rows), len(HISTORICAL_EXECUTION_FEATURE_NAMES)),
        dtype=np.float32,
    )
    event_index = 0
    for decision_date in sorted(indexes_by_date):
        while (
            event_index < len(events)
            and events[event_index][0] < decision_date
        ):
            _maturity, _decision, _episode, instrument, summary = events[
                event_index
            ]
            history[instrument].append(summary)
            event_index += 1
        for row_index in indexes_by_date[decision_date]:
            instrument_history = list(
                history[str(rows[row_index]["instrument_id"])]
            )
            if not instrument_history:
                features[row_index] = (0, 0.5, 0.5, 0.5, 0.5, 0.5, 0, 1)
                continue

            def average(position, default):
                values = [
                    item[position]
                    for item in instrument_history
                    if item[position] is not None
                ]
                return float(np.mean(values)) if values else default

            features[row_index] = (
                min(
                    math.log1p(len(instrument_history)) / math.log1p(window),
                    1,
                ),
                average(0, 0.5),
                average(1, 0.5),
                average(2, 0.5),
                average(3, 0.5),
                average(4, 0.5),
                average(5, 0),
                0,
            )
    if not np.all(np.isfinite(features)):
        raise ActionValueTrainingError(
            "ACTION_VALUE_HISTORY_FEATURE_NON_FINITE"
        )
    return features


def with_historical_execution_features(
    data: ActionValueTrainingData,
    history_features,
) -> ActionValueTrainingData:
    values = np.asarray(history_features, dtype=np.float32)
    if (
        values.shape
        != (len(data.features), len(HISTORICAL_EXECUTION_FEATURE_NAMES))
        or not np.all(np.isfinite(values))
        or data.feature_names[-len(SCENARIO_FEATURE_SUFFIX) :]
        != SCENARIO_FEATURE_SUFFIX
    ):
        raise ActionValueTrainingError(
            "ACTION_VALUE_HISTORY_FEATURE_CONTRACT_INVALID"
        )
    features = np.column_stack(
        (
            data.features[:, : -len(SCENARIO_FEATURE_SUFFIX)],
            values,
            data.features[:, -len(SCENARIO_FEATURE_SUFFIX) :],
        )
    )
    return replace(
        data,
        features=np.asarray(features, dtype=np.float32),
        feature_names=(
            *data.feature_names[: -len(SCENARIO_FEATURE_SUFFIX)],
            *HISTORICAL_EXECUTION_FEATURE_NAMES,
            *SCENARIO_FEATURE_SUFFIX,
        ),
    )


def load_enriched_action_value_training_data(
    *,
    episode_dataset_root: Path,
    label_dataset_root: Path,
    ranking_dataset_root: Path,
    factor_dataset_root: Path | None = None,
    feature_set: str = "technical",
) -> tuple[ActionValueTrainingData, dict]:
    import sqlite3

    from platform_app.modules.experiments.quant_model_trainer import (
        _verified_database,
        load_enriched_training_data,
    )

    quant_data, lineage = load_enriched_training_data(
        episode_dataset_root=episode_dataset_root,
        label_dataset_root=label_dataset_root,
        ranking_dataset_root=ranking_dataset_root,
    )
    _, label_path = _verified_database(label_dataset_root, "label-dataset.v2")
    with sqlite3.connect(
        f"{label_path.resolve().as_uri()}?mode=ro&immutable=1",
        uri=True,
    ) as database:
        database.row_factory = sqlite3.Row
        rows = database.execute(
            "SELECT decision_date,episode_id,instrument_id,fill_ratio,p_fill_label,"
            "p_full_fill_label,p_win_given_fill_label,net_return_given_fill,"
            "stop_hazard_label,entry_price,exit_price,filled_shares,"
            "buy_fees_cny,sell_fees_cny,target_notional_cny "
            "FROM episode_labels "
            "ORDER BY decision_date,episode_id,target_shares"
        ).fetchall()
    training = build_action_value_training_data(
        features=quant_data.scenario_x,
        feature_names=quant_data.scenario_feature_names,
        dates=quant_data.scenario_dates,
        boards=quant_data.scenario_boards,
        rows=rows,
    )
    if feature_set in {"factor", "fusion", "fusion_history"}:
        if factor_dataset_root is None:
            raise ActionValueTrainingError(
                "ACTION_VALUE_FACTOR_DATASET_REQUIRED"
            )
        from platform_app.modules.experiments.action_value_factor_dataset import (
            FEATURE_NAMES,
            load_factor_vectors,
        )

        factor_vectors, factor_manifest = load_factor_vectors(
            factor_dataset_root
        )
        if (
            factor_manifest["episodeDatabaseSha256"]
            != lineage["episodeManifest"]["databaseSha256"]
            or factor_manifest["rankingDatabaseSha256"]
            != lineage["rankingManifest"]["databaseSha256"]
        ):
            raise ActionValueTrainingError(
                "ACTION_VALUE_FACTOR_LINEAGE_MISMATCH"
            )
        training = with_multifactor_features(
            training,
            factor_vectors=factor_vectors,
            factor_feature_names=FEATURE_NAMES,
            feature_set=(
                "factor" if feature_set == "factor" else "fusion"
            ),
        )
        lineage = {
            **lineage,
            "factorManifest": factor_manifest,
        }
    elif feature_set not in FEATURE_SETS:
        raise ActionValueTrainingError("ACTION_VALUE_FEATURE_SET_INVALID")
    if feature_set in {"technical_history", "fusion_history"}:
        _, episode_path = _verified_database(
            episode_dataset_root,
            "episode-dataset.v4",
        )
        with sqlite3.connect(
            f"{episode_path.resolve().as_uri()}?mode=ro&immutable=1",
            uri=True,
        ) as episode_database:
            labeled_episodes = {
                str(row["episode_id"])
                for row in rows
            }
            maturity_dates = {
                row[0]: row[1]
                for row in episode_database.execute(
                    "SELECT l.episode_id,MAX(l.trade_date) "
                    "FROM episode_minute_requirements l "
                    "JOIN candidate_episodes e "
                    "ON e.episode_id=l.episode_id "
                    "GROUP BY l.episode_id"
                )
                if row[0] in labeled_episodes
            }
        training = with_historical_execution_features(
            training,
            historical_execution_feature_matrix(
                rows,
                maturity_dates=maturity_dates,
            ),
        )
    lineage = {**lineage, "featureSet": feature_set}
    return training, lineage
