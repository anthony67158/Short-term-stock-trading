from types import SimpleNamespace

import numpy as np

from platform_app.modules.experiments.ranking_catboost_runner import train_fold


def test_catboost_fold_is_reproducible_and_resumable(tmp_path):
    rng = np.random.default_rng(17)
    x = rng.normal(size=(300, 4)).astype(np.float32)
    data = SimpleNamespace(
        x=x,
        target_return=(0.2 * x[:, 0] - 0.1 * x[:, 1]).astype(np.float32),
        sample_weight=np.ones(300),
        dates=np.repeat(np.arange(100, 130), 10),
    )
    train = np.arange(300) < 200
    fusion = (np.arange(300) >= 200) & (np.arange(300) < 250)
    test = np.arange(300) >= 250
    first = train_fold(data, train, fusion, test, tmp_path, iterations=10, threads=1)
    second = train_fold(data, train, fusion, test, tmp_path, iterations=10, threads=1)
    np.testing.assert_array_equal(first[0], second[0])
    np.testing.assert_array_equal(first[1], second[1])
    assert (tmp_path / "catboost_return.cbm").is_file()
