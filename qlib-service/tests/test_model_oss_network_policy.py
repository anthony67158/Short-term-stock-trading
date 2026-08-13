import importlib
import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


QLIB_ROOT = Path(__file__).resolve().parents[1]
if str(QLIB_ROOT) not in sys.path:
    sys.path.insert(0, str(QLIB_ROOT))

model_lib = importlib.import_module("model_lib")
deploy_spec = importlib.util.spec_from_file_location(
    "deployed_model_lib",
    QLIB_ROOT / "deploy_pkg" / "model_lib.py",
)
deployed_model_lib = importlib.util.module_from_spec(deploy_spec)
deploy_spec.loader.exec_module(deployed_model_lib)


class ModelOssNetworkPolicyTests(unittest.TestCase):
    def test_missing_endpoint_defaults_to_same_region_internal_oss(self):
        with patch.dict(
            os.environ,
            {
                "OSS_REGION": "oss-cn-hangzhou",
                "OSS_ENDPOINT": "",
                "OSS_ALLOW_PUBLIC_NETWORK": "false",
            },
            clear=False,
        ):
            self.assertEqual(
                model_lib._resolve_oss_endpoint(),
                "https://oss-cn-hangzhou-internal.aliyuncs.com",
            )

    def test_public_endpoint_is_rejected_without_explicit_override(self):
        with patch.dict(
            os.environ,
            {
                "OSS_ENDPOINT": "https://oss-cn-hangzhou.aliyuncs.com",
                "OSS_ALLOW_PUBLIC_NETWORK": "false",
            },
            clear=False,
        ):
            with self.assertRaisesRegex(RuntimeError, "OSS public network is disabled"):
                model_lib._resolve_oss_endpoint()

    def test_deployed_model_lib_uses_the_same_internal_policy(self):
        with patch.dict(
            os.environ,
            {
                "OSS_REGION": "oss-cn-hangzhou",
                "OSS_ENDPOINT": "",
                "OSS_ALLOW_PUBLIC_NETWORK": "false",
            },
            clear=False,
        ):
            self.assertEqual(
                deployed_model_lib._resolve_oss_endpoint(),
                "https://oss-cn-hangzhou-internal.aliyuncs.com",
            )

    def test_quant_fc_deployment_forces_internal_oss(self):
        yaml = (QLIB_ROOT / "s.yaml").read_text(encoding="utf-8")
        self.assertIn(
            "OSS_ENDPOINT: https://oss-cn-hangzhou-internal.aliyuncs.com",
            yaml,
        )
        self.assertIn('OSS_ALLOW_PUBLIC_NETWORK: "false"', yaml)


if __name__ == "__main__":
    unittest.main()
