"""Contract for trigger-observation review features."""

import json
import math
import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(HERE)),
    "contracts",
    "opportunity-review-features.json",
)
with open(CONTRACT_PATH, encoding="utf-8") as _handle:
    _CONTRACT = json.load(_handle)

FEATURE_SCHEMA_VERSION = _CONTRACT["featureSchemaVersion"]
FEATURE_NAMES = tuple(_CONTRACT["featureNames"])
_CODE = re.compile(r"^\d{6}$")


def feature_vector(value):
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != FEATURE_SCHEMA_VERSION
        or not _CODE.fullmatch(str(value.get("code") or ""))
    ):
        raise ValueError("复核特征身份无效")
    factors = value.get("factors")
    if not isinstance(factors, dict) or tuple(factors) != FEATURE_NAMES:
        raise ValueError("复核特征字段不匹配")
    result = []
    for name in FEATURE_NAMES:
        try:
            number = float(factors[name])
        except (TypeError, ValueError) as error:
            raise ValueError("复核特征必须是有限数值") from error
        if not math.isfinite(number):
            raise ValueError("复核特征必须是有限数值")
        result.append(number)
    return result
