import importlib.util
import os
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
GUARD_PATH = os.path.join(HERE, "..", "cloud", "isolation_guard.py")


def load_guard():
    spec = importlib.util.spec_from_file_location("isolation_guard", GUARD_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LabIsolationGuardTest(unittest.TestCase):
    def setUp(self):
        self.guard = load_guard()
        self.bucket = "stock-quant-lab-1730034925594178"
        self.prefix = "models/challengers/run-20260810-001/"

    def test_accepts_the_explicit_lab_bucket_and_run_scoped_prefix(self):
        self.guard.require_lab_target(
            environment="lab",
            bucket=self.bucket,
            prefix=self.prefix,
            expected_bucket=self.bucket,
        )

    def test_rejects_any_environment_other_than_lab(self):
        with self.assertRaises(self.guard.LabIsolationError):
            self.guard.require_lab_target(
                environment="production",
                bucket=self.bucket,
                prefix=self.prefix,
                expected_bucket=self.bucket,
            )

    def test_rejects_a_bucket_that_does_not_match_the_configured_lab_bucket(self):
        with self.assertRaises(self.guard.LabIsolationError):
            self.guard.require_lab_target(
                environment="lab",
                bucket="stock-dashboard-production",
                prefix=self.prefix,
                expected_bucket=self.bucket,
            )

    def test_rejects_the_production_model_prefix(self):
        with self.assertRaises(self.guard.LabIsolationError):
            self.guard.require_lab_target(
                environment="lab",
                bucket=self.bucket,
                prefix="quantmodel/",
                expected_bucket=self.bucket,
            )

    def test_rejects_a_challenger_prefix_without_a_run_id(self):
        with self.assertRaises(self.guard.LabIsolationError):
            self.guard.require_lab_target(
                environment="lab",
                bucket=self.bucket,
                prefix="models/challengers/",
                expected_bucket=self.bucket,
            )

    def test_rejects_missing_values(self):
        with self.assertRaises(self.guard.LabIsolationError):
            self.guard.require_lab_target(
                environment="",
                bucket="",
                prefix="",
                expected_bucket=self.bucket,
            )


if __name__ == "__main__":
    unittest.main()
