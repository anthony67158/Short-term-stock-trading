"""Contract for trigger-observation review features."""

import json
import hashlib
import math
import os
import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(HERE)),
    "contracts",
    "opportunity-review-features-v2.json",
)
with open(CONTRACT_PATH, encoding="utf-8") as _handle:
    _CONTRACT = json.load(_handle)

FEATURE_SCHEMA_VERSION = _CONTRACT["featureSchemaVersion"]
FEATURE_NAMES = tuple(_CONTRACT["featureNames"])
_CODE = re.compile(r"^\d{6}$")
_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
REVIEW_PRICE_CONTRACT_SCHEMA_VERSION = "review-price-contract.v1"
_CANONICAL_PRICE_FIELDS = (
    "schemaVersion",
    "entryPriceMilliCny",
    "stopPriceMilliCny",
    "priceRiskMilliCny",
    "feeRateMilliBps",
    "slippageMilliBps",
    "lotSize",
    "tPlusOne",
    "exitPolicyVersion",
    "observationPolicyVersion",
)


def _scaled_integer(value, scale, maximum):
    if isinstance(value, bool) or value is None:
        raise ValueError("复核价格合同数值无效")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise ValueError("复核价格合同数值无效") from error
    if not number.is_finite() or number < 0 or number > maximum:
        raise ValueError("复核价格合同数值无效")
    return int((number * scale).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def review_price_contract(value):
    if not isinstance(value, dict):
        raise ValueError("复核价格合同无效")
    entry = _scaled_integer(value.get("entryPrice"), 1000, 1_000_000)
    stop = _scaled_integer(value.get("stopPrice"), 1000, 1_000_000)
    fee = _scaled_integer(value.get("feeRateBps"), 1000, 10_000)
    slippage = _scaled_integer(
        value.get("slippageBps"),
        1000,
        10_000,
    )
    lot_size = value.get("lotSize")
    exit_version = str(value.get("exitPolicyVersion") or "")
    observation_version = str(
        value.get("observationPolicyVersion") or ""
    )
    if (
        entry <= stop
        or stop <= 0
        or isinstance(lot_size, bool)
        or not isinstance(lot_size, int)
        or lot_size <= 0
        or not isinstance(value.get("tPlusOne"), bool)
        or not _VERSION.fullmatch(exit_version)
        or not _VERSION.fullmatch(observation_version)
    ):
        raise ValueError("复核价格合同无效")
    canonical = {
        "schemaVersion": REVIEW_PRICE_CONTRACT_SCHEMA_VERSION,
        "entryPriceMilliCny": entry,
        "stopPriceMilliCny": stop,
        "priceRiskMilliCny": entry - stop,
        "feeRateMilliBps": fee,
        "slippageMilliBps": slippage,
        "lotSize": lot_size,
        "tPlusOne": value["tPlusOne"],
        "exitPolicyVersion": exit_version,
        "observationPolicyVersion": observation_version,
    }
    raw = json.dumps(
        canonical,
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("ascii")
    return {
        "canonical": canonical,
        "hash": hashlib.sha256(raw).hexdigest(),
    }


def validate_bound_review_price_contract(value, checksum):
    if (
        not isinstance(value, dict)
        or set(value) != set(_CANONICAL_PRICE_FIELDS)
        or value.get("schemaVersion")
        != REVIEW_PRICE_CONTRACT_SCHEMA_VERSION
        or not isinstance(checksum, str)
        or not re.fullmatch(r"[0-9a-f]{64}", checksum)
    ):
        raise ValueError("复核价格合同无效")
    canonical = {
        name: value.get(name)
        for name in _CANONICAL_PRICE_FIELDS
    }
    integer_fields = (
        "entryPriceMilliCny",
        "stopPriceMilliCny",
        "priceRiskMilliCny",
        "feeRateMilliBps",
        "slippageMilliBps",
        "lotSize",
    )
    if (
        any(
            isinstance(canonical[name], bool)
            or not isinstance(canonical[name], int)
            or canonical[name] < 0
            for name in integer_fields
        )
        or canonical["entryPriceMilliCny"]
        <= canonical["stopPriceMilliCny"]
        or canonical["stopPriceMilliCny"] <= 0
        or canonical["priceRiskMilliCny"]
        != (
            canonical["entryPriceMilliCny"]
            - canonical["stopPriceMilliCny"]
        )
        or canonical["lotSize"] <= 0
        or not isinstance(canonical["tPlusOne"], bool)
        or not _VERSION.fullmatch(
            str(canonical["exitPolicyVersion"] or "")
        )
        or not _VERSION.fullmatch(
            str(canonical["observationPolicyVersion"] or "")
        )
    ):
        raise ValueError("复核价格合同无效")
    raw = json.dumps(
        canonical,
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("ascii")
    if hashlib.sha256(raw).hexdigest() != checksum:
        raise ValueError("复核价格合同摘要不匹配")
    return canonical


def feature_vector(value):
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != FEATURE_SCHEMA_VERSION
        or not _CODE.fullmatch(str(value.get("code") or ""))
    ):
        raise ValueError("复核特征身份无效")
    validate_bound_review_price_contract(
        value.get("priceContract"),
        value.get("priceContractHash"),
    )
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
