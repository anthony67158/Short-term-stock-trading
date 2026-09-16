import numpy as np

from platform_app.modules.experiments.quant_model_trainer import (
    QuantTrainingData,
    temporal_split,
    train_quant_models,
)


def _training_data():
    rng = np.random.default_rng(97240)
    base_dates = np.repeat(np.arange(20200101, 20200201), 8)
    base_x = rng.normal(size=(len(base_dates), 10)).astype(np.float32)
    p_fill = (base_x[:, 0] + base_x[:, 1] > 0).astype(np.int8)
    stop = (base_x[:, 2] > 0).astype(np.int8)
    scenario_x = np.repeat(base_x, 2, axis=0)
    sizes = np.tile(np.array([[10.0, 4.0, -5.0], [12.0, 6.0, -2.0]]), (len(base_x), 1))
    scenario_x = np.concatenate([scenario_x, sizes.astype(np.float32)], axis=1)
    scenario_dates = np.repeat(base_dates, 2)
    net_return = (
        scenario_x[:, 0] * 0.02
        - scenario_x[:, 10] * 0.0005
        + rng.normal(scale=0.01, size=len(scenario_x))
    ).astype(np.float32)
    return QuantTrainingData(
        base_x=base_x,
        base_dates=base_dates.astype(np.int32),
        base_boards=np.tile(np.arange(4, dtype=np.int8), len(base_dates) // 4),
        p_fill=p_fill,
        stop_hazard=stop,
        stop_available=np.ones(len(base_dates), dtype=bool),
        scenario_x=scenario_x,
        scenario_dates=scenario_dates.astype(np.int32),
        scenario_boards=np.repeat(
            np.tile(np.arange(4, dtype=np.int8), len(base_dates) // 4),
            2,
        ),
        p_full_fill=(scenario_x[:, 1] > 0).astype(np.int8),
        p_win=(net_return > 0).astype(np.int8),
        net_return=net_return,
        conditional_available=np.ones(len(scenario_x), dtype=bool),
    )


def test_temporal_split_has_five_session_embargoes():
    dates = np.repeat(np.arange(20200101, 20200201), 2)
    split = temporal_split(dates)
    train, calibration, confirmation = split.masks(dates)

    assert dates[train].max() < dates[calibration].min()
    assert dates[calibration].max() < dates[confirmation].min()
    unique = np.unique(dates)
    assert (
        np.where(unique == split.calibration_start)[0][0]
        - np.where(unique == split.train_end)[0][0]
        == 6
    )
    assert (
        np.where(unique == split.confirmation_start)[0][0]
        - np.where(unique == split.calibration_end)[0][0]
        == 6
    )


def test_quant_models_emit_all_required_targets_on_confirmation_data():
    models, metrics = train_quant_models(
        _training_data(),
        max_iter=5,
        min_samples_leaf=5,
    )

    assert set(models) == {
        "pFill",
        "pFullFill",
        "pWinGivenFill",
        "stopHazard",
        "expectedNetReturnGivenFill",
        "q10",
        "q50",
        "q90",
    }
    assert metrics["pFill"]["samples"] > 0
    assert metrics["pWinGivenFill"]["samples"] > 0
    assert 0 <= metrics["q10Q90Coverage"] <= 1
