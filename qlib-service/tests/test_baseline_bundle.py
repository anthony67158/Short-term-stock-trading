import hashlib
import importlib.util
import json
import os
import tempfile
import time
import unittest
import zipfile


HERE = os.path.dirname(os.path.abspath(__file__))
BUILDER_PATH = os.path.join(HERE, "..", "cloud", "build_baseline_bundle.py")


def load_builder():
    spec = importlib.util.spec_from_file_location("build_baseline_bundle", BUILDER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BaselineBundleTest(unittest.TestCase):
    def setUp(self):
        self.builder = load_builder()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = self.temp.name
        for relative in self.builder.BUNDLE_FILES:
            path = os.path.join(self.root, relative)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as handle:
                handle.write(f"content:{relative}".encode())

    def test_bundle_contains_only_allowlisted_files_and_manifest(self):
        output = os.path.join(self.root, "baseline.zip")

        self.builder.build_bundle(self.root, output)

        with zipfile.ZipFile(output) as archive:
            names = set(archive.namelist())
            self.assertEqual(
                names,
                set(self.builder.BUNDLE_FILES) | {"bundle_manifest.json"},
            )
            self.assertNotIn(".env", names)
            self.assertNotIn("upload_model.py", names)
            self.assertNotIn("retrain_daily.py", names)

    def test_manifest_records_hash_and_size_for_every_file(self):
        output = os.path.join(self.root, "baseline.zip")

        self.builder.build_bundle(self.root, output)

        with zipfile.ZipFile(output) as archive:
            manifest = json.loads(archive.read("bundle_manifest.json"))
            self.assertEqual(manifest["bundle_type"], "quant-lab-baseline")
            self.assertEqual(
                set(manifest["files"]),
                set(self.builder.BUNDLE_FILES),
            )
            for relative in self.builder.BUNDLE_FILES:
                content = archive.read(relative)
                record = manifest["files"][relative]
                self.assertEqual(record["size"], len(content))
                self.assertEqual(
                    record["sha256"],
                    hashlib.sha256(content).hexdigest(),
                )

    def test_missing_required_file_fails_without_creating_bundle(self):
        missing = self.builder.BUNDLE_FILES[0]
        os.remove(os.path.join(self.root, missing))
        output = os.path.join(self.root, "baseline.zip")

        with self.assertRaises(FileNotFoundError):
            self.builder.build_bundle(self.root, output)

        self.assertFalse(os.path.exists(output))

    def test_identical_inputs_produce_the_same_bundle_hash(self):
        first = os.path.join(self.root, "first.zip")
        second = os.path.join(self.root, "second.zip")

        self.builder.build_bundle(self.root, first)
        time.sleep(2.1)
        self.builder.build_bundle(self.root, second)

        with open(first, "rb") as handle:
            first_hash = hashlib.sha256(handle.read()).hexdigest()
        with open(second, "rb") as handle:
            second_hash = hashlib.sha256(handle.read()).hexdigest()
        self.assertEqual(first_hash, second_hash)


if __name__ == "__main__":
    unittest.main()
