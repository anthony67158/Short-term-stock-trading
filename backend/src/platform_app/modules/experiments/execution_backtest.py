"""Causal out-of-time selection and execution coverage audit."""

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
)

BOARD_NAMES = ("MAIN", "CHINEXT", "STAR", "BEIJING")


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
