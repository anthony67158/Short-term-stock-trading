"""Stable contract for the independent opportunity-ranking sidecar."""

import json
import math
import os
import re


HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT_PATH = os.path.join(
    HERE,
    "contracts",
    "opportunity-score-features.json",
)

with open(CONTRACT_PATH, encoding="utf-8") as _handle:
    _CONTRACT = json.load(_handle)

FEATURE_SCHEMA_VERSION = _CONTRACT["featureSchemaVersion"]
SCORE_SCHEMA_VERSION = _CONTRACT["scoreSchemaVersion"]
FEATURE_NAMES = tuple(_CONTRACT["featureNames"])
_FEATURE_SET = frozenset(FEATURE_NAMES)
_CODE = re.compile(r"^\d{6}$")


def _finite(value, label):
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label}必须是有限数值") from error
    if not math.isfinite(number):
        raise ValueError(f"{label}必须是有限数值")
    return number


def validate_score_item(item):
    if not isinstance(item, dict):
        raise ValueError("机会评分项目必须是对象")
    if item.get("schemaVersion") != FEATURE_SCHEMA_VERSION:
        raise ValueError("机会评分特征版本无效")
    code = str(item.get("code") or "")
    if not _CODE.fullmatch(code):
        raise ValueError("机会评分股票代码无效")
    formula_id = str(item.get("formulaId") or "")
    if not formula_id or len(formula_id) > 60:
        raise ValueError("机会评分公式无效")
    factors = item.get("factors")
    if not isinstance(factors, dict) or set(factors) != _FEATURE_SET:
        raise ValueError("机会评分特征字段不匹配")
    normalized = {
        name: _finite(factors[name], "机会评分特征")
        for name in FEATURE_NAMES
    }
    return {
        "schemaVersion": FEATURE_SCHEMA_VERSION,
        "asOf": int(_finite(item.get("asOf"), "机会评分时点")),
        "code": code,
        "formulaId": formula_id,
        "factors": normalized,
    }


def validate_score_request(payload):
    if not isinstance(payload, dict):
        raise ValueError("机会评分请求必须是对象")
    items = payload.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= 80:
        raise ValueError("机会评分items必须包含1到80项")
    return [validate_score_item(item) for item in items]


def feature_vector(item):
    normalized = validate_score_item(item)
    return [
        normalized["factors"][name]
        for name in FEATURE_NAMES
    ]


def not_ready_prediction(item, reason="MODEL_NOT_READY"):
    return {
        "schemaVersion": SCORE_SCHEMA_VERSION,
        "state": "NOT_READY",
        "reason": str(reason or "MODEL_NOT_READY")[:80],
        "modelVersion": None,
        "asOf": int(item.get("asOf") or 0),
        "code": str(item.get("code") or ""),
        "formulaId": str(item.get("formulaId") or ""),
        "pFill": None,
        "pWinGivenFill": None,
        "expectedNetR": None,
        "netRLowerBound": None,
        "expectedShortfall10": None,
        "calibration": None,
        "outOfDistribution": False,
    }
