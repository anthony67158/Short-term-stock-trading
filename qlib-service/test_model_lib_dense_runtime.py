import importlib.util
import os
import sys
import types
import unittest
from unittest import mock


HERE = os.path.dirname(os.path.abspath(__file__))


def load_model_lib():
    spec = importlib.util.spec_from_file_location(
        "model_lib_dense_runtime_under_test",
        os.path.join(HERE, "model_lib.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DenseRuntimeCompatibilityTest(unittest.TestCase):
    def test_sparse_stub_has_lightgbm_dense_import_contract(self):
        model_lib = load_model_lib()

        scipy_module, sparse_module = model_lib._dense_scipy_modules()

        self.assertIs(scipy_module.sparse, sparse_module)
        self.assertTrue(hasattr(sparse_module, "spmatrix"))
        self.assertTrue(hasattr(sparse_module, "csr_matrix"))
        self.assertTrue(hasattr(sparse_module, "csc_matrix"))
        self.assertTrue(hasattr(sparse_module, "hstack"))
        with self.assertRaisesRegex(RuntimeError, "dense inference"):
            sparse_module.hstack([])

    def test_expired_score_model_cache_rechecks_oss_even_with_local_file(self):
        model_lib = load_model_lib()
        booster = object()
        model_lib._MODEL = object()
        model_lib._META = {"old": True}
        model_lib._LOAD_TS = 1
        fake_lightgbm = types.SimpleNamespace(
            Booster=lambda model_file: booster,
        )

        with (
            mock.patch.object(model_lib.time, "time", return_value=model_lib._TTL + 2),
            mock.patch.object(model_lib, "_download_model", return_value=False) as download,
            mock.patch.object(model_lib, "_ensure_lightgbm_dense_imports"),
            mock.patch.object(
                model_lib.os.path,
                "exists",
                side_effect=lambda path: path == model_lib.LOCAL_MODEL,
            ),
            mock.patch.dict(sys.modules, {"lightgbm": fake_lightgbm}),
        ):
            loaded, meta = model_lib.get_model()

        download.assert_called_once_with()
        self.assertIs(loaded, booster)
        self.assertEqual(meta, {"feat_names": None})

    def test_expired_signal_model_cache_rechecks_oss_even_with_local_file(self):
        model_lib = load_model_lib()
        booster = object()
        model_lib._SIGNAL = object()
        model_lib._SIGNAL_META = {"old": True}
        model_lib._SIGNAL_TS = 1
        fake_lightgbm = types.SimpleNamespace(
            Booster=lambda model_file: booster,
        )

        with (
            mock.patch.object(model_lib.time, "time", return_value=model_lib._TTL + 2),
            mock.patch.object(model_lib, "_download_signal", return_value=False) as download,
            mock.patch.object(model_lib, "_ensure_lightgbm_dense_imports"),
            mock.patch.object(
                model_lib.os.path,
                "exists",
                side_effect=lambda path: path == model_lib.LOCAL_SIGNAL,
            ),
            mock.patch.dict(sys.modules, {"lightgbm": fake_lightgbm}),
        ):
            loaded, meta = model_lib.get_signal_model()

        download.assert_called_once_with()
        self.assertIs(loaded, booster)
        self.assertIsNone(meta)


if __name__ == "__main__":
    unittest.main()
