import json
import math
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE_ROOT = os.path.abspath(os.path.join(HERE, ".."))
ROOT = os.path.abspath(os.path.join(SERVICE_ROOT, ".."))
if SERVICE_ROOT not in sys.path:
    sys.path.insert(0, SERVICE_ROOT)

from decision_engine.heads.review_contract import (  # noqa: E402
    FEATURE_NAMES as V3_NAMES,
)
from decision_engine.heads.review_contract_v4 import (  # noqa: E402
    ALPHA_FEATURE_COUNT,
    ALPHA_FEATURE_NAMES,
    FEATURE_NAMES_V4,
    FEATURE_SCHEMA_VERSION_V4,
    REVIEW_V3_FEATURE_COUNT,
    feature_vector_v4,
)


def price_contract():
    # 复用一份合法的 review 价格合同（来自 review_contract 的构造器）。
    from decision_engine.heads.review_contract import review_price_contract
    return review_price_contract({
        "entryPrice": 10.2,
        "stopPrice": 9.8,
        "feeRateBps": 6.1,
        "slippageBps": 5,
        "lotSize": 100,
        "tPlusOne": True,
        "exitPolicyVersion": "trailing-exit.v1",
        "observationPolicyVersion": "trigger-review-observation.v1",
    })


class ReviewContractV4Test(unittest.TestCase):
    def test_v4_is_v3_prefix_plus_alpha_block(self):
        self.assertEqual(len(FEATURE_NAMES_V4),
                         REVIEW_V3_FEATURE_COUNT + ALPHA_FEATURE_COUNT)
        # 前 168 维与 v3 逐位一致。
        self.assertEqual(FEATURE_NAMES_V4[:len(V3_NAMES)], tuple(V3_NAMES))
        # alpha 段带前缀且顺序保持。
        self.assertEqual(
            FEATURE_NAMES_V4[len(V3_NAMES):],
            tuple(f"alpha_{name}" for name in ALPHA_FEATURE_NAMES),
        )

    def test_alpha_names_match_js_contract_source(self):
        # 与 JS 侧同一份契约文件对齐（跨语言唯一真源）。
        path = os.path.join(
            SERVICE_ROOT, "contracts", "opportunity-alpha158-signal.json",
        )
        with open(path, encoding="utf-8") as handle:
            contract = json.load(handle)
        self.assertEqual(list(ALPHA_FEATURE_NAMES), contract["featureNames"])
        self.assertEqual(len(ALPHA_FEATURE_NAMES), 8)

    def test_feature_vector_v4_expands_in_order(self):
        contract = price_contract()
        factors = {name: 0.0 for name in FEATURE_NAMES_V4}
        # 给几个 alpha 维非零值，确认按名取值、顺序正确。
        factors["alpha_alphaScorePctRank"] = 0.9
        factors["alpha_alphaScoreZ"] = 0.8
        value = {
            "schemaVersion": FEATURE_SCHEMA_VERSION_V4,
            "code": "600519",
            "priceContract": contract["canonical"],
            "priceContractHash": contract["hash"],
            "factors": factors,
        }
        vec = feature_vector_v4(value)
        self.assertEqual(len(vec), len(FEATURE_NAMES_V4))
        idx_pct = FEATURE_NAMES_V4.index("alpha_alphaScorePctRank")
        idx_z = FEATURE_NAMES_V4.index("alpha_alphaScoreZ")
        self.assertEqual(vec[idx_pct], 0.9)
        self.assertEqual(vec[idx_z], 0.8)

    def test_feature_vector_v4_rejects_wrong_field_set(self):
        contract = price_contract()
        value = {
            "schemaVersion": FEATURE_SCHEMA_VERSION_V4,
            "code": "600519",
            "priceContract": contract["canonical"],
            "priceContractHash": contract["hash"],
            "factors": {"only": 1.0},
        }
        with self.assertRaisesRegex(ValueError, "字段不匹配"):
            feature_vector_v4(value)

    def test_feature_vector_v4_rejects_non_finite(self):
        contract = price_contract()
        factors = {name: 0.0 for name in FEATURE_NAMES_V4}
        factors["alpha_alphaScoreZ"] = math.inf
        value = {
            "schemaVersion": FEATURE_SCHEMA_VERSION_V4,
            "code": "600519",
            "priceContract": contract["canonical"],
            "priceContractHash": contract["hash"],
            "factors": factors,
        }
        with self.assertRaisesRegex(ValueError, "有限数值"):
            feature_vector_v4(value)

    def test_v3_default_contract_untouched(self):
        # v3 仍是 168 维、生产 schema 名不变。
        self.assertEqual(REVIEW_V3_FEATURE_COUNT, 168)
        self.assertEqual(FEATURE_SCHEMA_VERSION_V4,
                         "opportunity-review-feature.v4")


if __name__ == "__main__":
    unittest.main()
