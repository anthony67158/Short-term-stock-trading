from types import SimpleNamespace

import numpy as np
import pytest
import torch

from platform_app.modules.experiments.quant_model_trainer import QuantModelError
from platform_app.modules.experiments.ranking_tabm_runner import (
    fit_preprocessor,
    independent_ensemble_mse,
    train_fold,
)


def test_independent_ensemble_loss_does_not_score_only_the_mean_prediction():
    predictions = torch.tensor([[0.0, 2.0], [2.0, 0.0]])
    target = torch.ones(2)
    weight = torch.ones(2)

    assert independent_ensemble_mse(predictions, target, weight).item() == 1.0
    assert torch.nn.functional.mse_loss(predictions.mean(dim=1), target).item() == 0.0


def test_independent_ensemble_loss_rejects_misaligned_shapes():
    with pytest.raises(QuantModelError, match="TABM_LOSS_SHAPE_INVALID"):
        independent_ensemble_mse(
            torch.ones(2, 3),
            torch.ones(3),
            torch.ones(3),
        )


def test_preprocessor_uses_only_training_rows():
    x = np.array([[1.0, 2.0], [3.0, 6.0], [10_000.0, -10_000.0]], dtype=np.float32)
    target = np.array([1.0, 3.0, 10_000.0], dtype=np.float32)

    result = fit_preprocessor(x, target, np.array([0, 1]))

    np.testing.assert_allclose(result["featureMean"], [2.0, 4.0])
    np.testing.assert_allclose(result["featureScale"], [1.0, 2.0])
    assert result["targetMean"] == pytest.approx(2.0)
    assert result["targetUpper"] < 4.0


def test_tabm_fold_is_reproducible_and_resumable(tmp_path):
    rng = np.random.default_rng(17)
    x = rng.normal(size=(120, 4)).astype(np.float32)
    data = SimpleNamespace(
        x=x,
        target_return=(0.2 * x[:, 0] - 0.1 * x[:, 1]).astype(np.float32),
        sample_weight=np.ones(120, dtype=np.float32),
        dates=np.repeat(np.arange(100, 112), 10),
    )
    train = np.arange(120) < 80
    fusion = (np.arange(120) >= 80) & (np.arange(120) < 100)
    test = np.arange(120) >= 100
    options = {
        "architecture": "tabm-mini",
        "seed": 17,
        "epochs": 1,
        "batch_size": 32,
        "members": 4,
        "blocks": 1,
        "width": 8,
        "dropout": 0.0,
        "learning_rate": 1e-3,
        "device_name": "cpu",
    }

    first = train_fold(data, train, fusion, test, tmp_path, **options)
    second = train_fold(data, train, fusion, test, tmp_path, **options)

    np.testing.assert_array_equal(first[0], second[0])
    np.testing.assert_array_equal(first[1], second[1])
    assert (tmp_path / "tabm_mini_return_s17.pt").is_file()
