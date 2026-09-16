import sqlite3

import numpy as np

from platform_app.modules.experiments.execution_backtest import (
    _coverage_summary,
    _load_execution_matches,
    select_confirmation_candidates,
)
from platform_app.modules.experiments.ranking_model_trainer import (
    RankingTrainingData,
)


class _RankingBundle:
    @staticmethod
    def predict_matrix(values):
        return {
            "rankScore": values[:, 0],
            "expectedGrossReturn": values[:, 1],
        }


def _training_data():
    dates = np.repeat(np.arange(20200101, 20200151), 3)
    scores = np.tile([1.0, 3.0, 3.0], 50)
    expected = np.tile([0.01, 0.03, 0.02], 50)
    x = np.column_stack((scores, expected)).astype(np.float32)
    return RankingTrainingData(
        x=x,
        dates=dates,
        boards=np.tile([0, 1, 2], 50),
        instruments=np.tile(
            np.asarray([b"SH.000001", b"SZ.300001", b"SH.688001"]),
            50,
        ),
        target_return=np.zeros(len(dates)),
        target_rank=np.zeros(len(dates)),
        sample_weight=np.ones(len(dates)),
    )


def test_select_confirmation_candidates_uses_full_date_universe_and_stable_ties():
    data = _training_data()

    selections, split = select_confirmation_candidates(
        data,
        _RankingBundle(),
        top_n=1,
    )

    assert selections
    assert {row["decisionDate"] for row in selections} == {
        str(value)
        for value in np.unique(data.dates[data.dates >= split.confirmation_start])
    }
    assert {row["instrumentId"] for row in selections} == {"SH.688001"}
    assert {row["board"] for row in selections} == {"STAR"}
    assert {row["universeSize"] for row in selections} == {3}


def test_execution_coverage_distinguishes_missing_candidate_and_minute_path(
    tmp_path,
):
    episode_path = tmp_path / "episodes.sqlite3"
    episodes = sqlite3.connect(episode_path)
    episodes.execute(
        "CREATE TABLE candidate_episodes ("
        "decision_date TEXT, instrument_id TEXT, episode_id TEXT)"
    )
    episodes.executemany(
        "INSERT INTO candidate_episodes VALUES (?, ?, ?)",
        [
            ("20250102", "SH.600001", "episode-1"),
            ("20250102", "SZ.300001", "episode-2"),
        ],
    )
    episodes.commit()
    episodes.close()

    label_path = tmp_path / "labels.sqlite3"
    labels = sqlite3.connect(label_path)
    labels.execute(
        "CREATE TABLE episode_labels ("
        "decision_date TEXT, instrument_id TEXT, reference_100k INTEGER, "
        "target_notional_cny TEXT, target_shares INTEGER, filled_shares INTEGER, "
        "fill_ratio TEXT, p_fill_label INTEGER, p_full_fill_label INTEGER, "
        "net_return_given_fill TEXT, exit_reason TEXT)"
    )
    labels.executemany(
        "INSERT INTO episode_labels VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                "20250102",
                "SH.600001",
                0,
                "120000",
                100,
                100,
                "1",
                1,
                1,
                "0.03",
                "TERMINAL",
            ),
            (
                "20250102",
                "SH.600001",
                1,
                "99900",
                100,
                50,
                "0.5",
                1,
                0,
                "0.02",
                "TERMINAL",
            ),
        ],
    )
    labels.commit()
    labels.close()
    selections = [
        {
            "decisionDate": "20250102",
            "instrumentId": instrument_id,
            "board": board,
            "rankPosition": rank,
            "rankScore": 1 - rank / 10,
            "expectedGrossReturn": 0.02,
            "universeSize": 3,
        }
        for rank, (instrument_id, board) in enumerate(
            [
                ("SH.600001", "MAIN"),
                ("SZ.300001", "CHINEXT"),
                ("BJ.920001", "BEIJING"),
            ],
            start=1,
        )
    ]

    matches = _load_execution_matches(
        selections,
        episode_database=episode_path,
        label_database=label_path,
    )
    summary = _coverage_summary(matches)

    assert [row["coverageStatus"] for row in matches] == [
        "COVERED",
        "MINUTE_PATH_UNAVAILABLE",
        "NOT_IN_LEGACY_MINUTE_UNIVERSE",
    ]
    assert matches[0]["reference100k"] is True
    assert matches[0]["returnOnRequestedCapital"] == 0.01
    assert matches[0]["returnAt10BpsStress"] == 0.0095
    assert summary["coverageRate"] == 1 / 3
    assert summary["fullyCoveredDates"] == 0
