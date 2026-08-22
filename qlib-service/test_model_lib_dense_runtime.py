import importlib.util
import hashlib
import json
import os
import sys
import tempfile
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

    def test_release_manifest_requires_same_run_and_valid_hashes(self):
        model_lib = load_model_lib()
        model_hash = hashlib.sha256(b"model").hexdigest()
        meta_hash = hashlib.sha256(b"meta").hexdigest()
        manifest = {
            "schema_version": 1,
            "run_id": "run-20260821",
            "files": {
                "model": {
                    "key": "quantmodel/runs/run-20260821/lgb_score.txt",
                    "sha256": model_hash,
                },
                "meta": {
                    "key": "quantmodel/runs/run-20260821/meta.json",
                    "sha256": meta_hash,
                },
            },
        }

        validated = model_lib.validate_release_manifest(manifest)

        self.assertEqual(validated["run_id"], "run-20260821")
        with self.assertRaises(ValueError):
            model_lib.validate_release_manifest({
                **manifest,
                "files": {
                    **manifest["files"],
                    "model": {
                        **manifest["files"]["model"],
                        "key": "other/model.txt",
                    },
                },
            })

    def test_download_model_uses_one_verified_manifest_release(self):
        model_lib = load_model_lib()
        model_bytes = b"model-release"
        meta_bytes = json.dumps({"feat_names": ["mom5"]}).encode("utf-8")
        manifest = {
            "schema_version": 1,
            "run_id": "run-20260821",
            "files": {
                "model": {
                    "key": "quantmodel/runs/run-20260821/lgb_score.txt",
                    "sha256": hashlib.sha256(model_bytes).hexdigest(),
                },
                "meta": {
                    "key": "quantmodel/runs/run-20260821/meta.json",
                    "sha256": hashlib.sha256(meta_bytes).hexdigest(),
                },
            },
        }
        objects = {
            model_lib.MANIFEST_KEY: json.dumps(manifest).encode("utf-8"),
            manifest["files"]["model"]["key"]: model_bytes,
            manifest["files"]["meta"]["key"]: meta_bytes,
        }

        class Object:
            def __init__(self, value):
                self.value = value

            def read(self):
                return self.value

        class Bucket:
            def get_object(self, key):
                return Object(objects[key])

        with tempfile.TemporaryDirectory() as directory:
            with (
                mock.patch.object(
                    model_lib,
                    "LOCAL_RELEASE_ROOT",
                    directory,
                ),
                mock.patch.object(
                    model_lib,
                    "_oss_bucket",
                    return_value=Bucket(),
                ),
                mock.patch.dict(
                    sys.modules,
                    {
                        "lightgbm": types.SimpleNamespace(
                            Booster=lambda model_file: object(),
                        ),
                    },
                ),
            ):
                model_path, meta_path = model_lib._download_model()

                with open(model_path, "rb") as handle:
                    self.assertEqual(handle.read(), model_bytes)
                with open(meta_path, "rb") as handle:
                    self.assertEqual(handle.read(), meta_bytes)
                self.assertIn("run-20260821", model_path)


if __name__ == "__main__":
    unittest.main()
