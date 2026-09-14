"""V4 复核特征契约：V3(触价+初始候选) + Alpha158 连续信号块。

为什么单独一层而不改 review_contract.py：
  review_contract 的模块级 FEATURE_NAMES / feature_vector 绑定的是当前**生产**
  的 v3 契约与价格合同哈希，线上 V3 推理、上传/下载校验、门禁都依赖它。v4 是
  新契约，只在启用 Alpha158 连续特征的**挑战者**训练/推理中显式选用，绝不改
  v3 默认，避免污染已部署模型。

组成（严格顺序）：
  V2 触价/价格/执行特征 → initial_ 初始候选评分特征 → alpha_ Alpha158 连续信号。
  前两段直接复用 v3 的 base/initial 契约文件，保证与 v3 前 168 维逐位一致；
  alpha 段来自 opportunity-alpha158-signal.json，缺失时由调用方填 0 中性 + Missing。
"""

from __future__ import annotations

import json
import math
import os

from .review_contract import (
    FEATURE_NAMES as REVIEW_FEATURE_NAMES_V3,
    validate_bound_review_price_contract,
    _CODE,
)

HERE = os.path.dirname(os.path.abspath(__file__))
_CONTRACT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(HERE)),
    "contracts",
)
_V4_PATH = os.path.join(
    _CONTRACT_DIR, "opportunity-review-features-v4.json",
)
with open(_V4_PATH, encoding="utf-8") as _handle:
    _V4 = json.load(_handle)

with open(
    os.path.join(_CONTRACT_DIR, _V4["alphaFeatureContract"]),
    encoding="utf-8",
) as _handle:
    _ALPHA = json.load(_handle)

FEATURE_SCHEMA_VERSION_V4 = _V4["featureSchemaVersion"]
ALPHA_PREFIX = _V4["alphaFeaturePrefix"]
ALPHA_FEATURE_NAMES = tuple(_ALPHA["featureNames"])
# v4 = v3(168) 原样在前 + alpha_ 前缀块在后。
FEATURE_NAMES_V4 = tuple([
    *REVIEW_FEATURE_NAMES_V3,
    *[f"{ALPHA_PREFIX}{name}" for name in ALPHA_FEATURE_NAMES],
])
REVIEW_V3_FEATURE_COUNT = len(REVIEW_FEATURE_NAMES_V3)
ALPHA_FEATURE_COUNT = len(ALPHA_FEATURE_NAMES)


def feature_vector_v4(value):
    """校验并展开一条 v4 特征输入为定长数值向量（顺序=FEATURE_NAMES_V4）。

    与 v3 feature_vector 同样严格：身份/价格合同哈希/字段全等/有限数值。
    """
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != FEATURE_SCHEMA_VERSION_V4
        or not _CODE.fullmatch(str(value.get("code") or ""))
    ):
        raise ValueError("复核特征身份无效(v4)")
    validate_bound_review_price_contract(
        value.get("priceContract"),
        value.get("priceContractHash"),
    )
    factors = value.get("factors")
    if not isinstance(factors, dict) or tuple(factors) != FEATURE_NAMES_V4:
        raise ValueError("复核特征字段不匹配(v4)")
    result = []
    for name in FEATURE_NAMES_V4:
        try:
            number = float(factors[name])
        except (TypeError, ValueError) as error:
            raise ValueError("复核特征必须是有限数值(v4)") from error
        if not math.isfinite(number):
            raise ValueError("复核特征必须是有限数值(v4)")
        result.append(number)
    return result
