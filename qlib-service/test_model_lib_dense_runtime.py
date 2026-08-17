import importlib.util
import os
import unittest


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


if __name__ == "__main__":
    unittest.main()
