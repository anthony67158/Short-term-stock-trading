import numpy as np

from platform_app.modules.experiments.execution_backtest import (
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
