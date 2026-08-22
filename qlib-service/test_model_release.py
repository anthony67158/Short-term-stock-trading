import hashlib
import importlib.util
import json
import os
import tempfile
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))


def load_uploader():
    spec = importlib.util.spec_from_file_location(
        "upload_model_under_test",
        os.path.join(HERE, "upload_model.py"),
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeBucket:
    def __init__(self):
        self.objects = {}
        self.order = []

    def put_object_from_file(self, key, path, headers=None):
        with open(path, "rb") as handle:
            self.objects[key] = handle.read()
        self.order.append(key)
        if headers != {"x-oss-forbid-overwrite": "true"}:
            raise AssertionError("release files must be immutable")

    def put_object(self, key, body):
        self.objects[key] = bytes(body)
        self.order.append(key)


class ModelReleaseTest(unittest.TestCase):
    def test_release_uploads_immutable_files_then_switches_manifest(self):
        uploader = load_uploader()
        bucket = FakeBucket()
        with tempfile.TemporaryDirectory() as directory:
            model = os.path.join(directory, "model.txt")
            meta = os.path.join(directory, "meta.json")
            with open(model, "wb") as handle:
                handle.write(b"model-v1")
            with open(meta, "w", encoding="utf-8") as handle:
                json.dump({"run_id": "run-20260821", "trained_at": 1}, handle)

            manifest = uploader.publish_release(
                bucket,
                [("model", model, "lgb_score.txt"),
                 ("meta", meta, "meta.json")],
                prefix="quantmodel/",
                run_id="run-20260821",
                activated_at=123,
            )

        self.assertEqual(bucket.order[-1], "quantmodel/manifest.json")
        self.assertEqual(manifest["run_id"], "run-20260821")
        self.assertEqual(
            manifest["files"]["model"]["key"],
            "quantmodel/runs/run-20260821/lgb_score.txt",
        )
        self.assertEqual(
            manifest["files"]["model"]["sha256"],
            hashlib.sha256(b"model-v1").hexdigest(),
        )
        self.assertEqual(
            json.loads(bucket.objects["quantmodel/manifest.json"]),
            manifest,
        )

    def test_release_id_rejects_paths_and_uses_metadata_fallback(self):
        uploader = load_uploader()

        self.assertEqual(
            uploader.release_id({"run_id": "daily-20260821"}),
            "daily-20260821",
        )
        self.assertEqual(
            uploader.release_id({"trained_at": 1787353200}),
            "run-1787353200",
        )
        with self.assertRaises(ValueError):
            uploader.release_id({"run_id": "../production"})


if __name__ == "__main__":
    unittest.main()
