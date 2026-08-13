"""Validated cross-runtime contract for strategy-spec.v1."""

import copy
import json
import math
import re
import urllib.request


SCHEMA_VERSION = "strategy-spec.v1"
ALLOWED_FIELDS = {
    "amount",
    "mainRatio",
    "marketEnv.score",
    "marketScore",
    "pct",
    "quant.expRet",
    "quant.highConfFired",
    "quant.score",
    "quant.upProb",
    "speed",
    "turnover",
    "volRatio",
}
ALLOWED_OPERATORS = {
    "BETWEEN",
    "EQ",
    "GT",
    "GTE",
    "IN",
    "LT",
    "LTE",
    "NE",
}


def _stable_value(value):
    if isinstance(value, list):
        return [_stable_value(item) for item in value]
    if isinstance(value, dict):
        return {
            key: _stable_value(value[key])
            for key in sorted(value)
            if key != "specVersion"
        }
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _base36(value):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    output = ""
    while value:
        value, remainder = divmod(value, 36)
        output = digits[remainder] + output
    return output


def strategy_fingerprint(spec):
    canonical = json.dumps(
        _stable_value(spec),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    hash_value = 2166136261
    encoded = canonical.encode("utf-16-le")
    for index in range(0, len(encoded), 2):
        code_unit = encoded[index] | (encoded[index + 1] << 8)
        hash_value ^= code_unit
        hash_value = (hash_value * 16777619) & 0xFFFFFFFF
    return "strategy." + _base36(hash_value)


def _positive(value, name):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError("%s must be positive and finite" % name)
    if not math.isfinite(number) or number <= 0:
        raise ValueError("%s must be positive and finite" % name)
    return number


def _finite_number(value, name):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError("%s must be finite" % name)
    if not math.isfinite(number):
        raise ValueError("%s must be finite" % name)
    return number


def _validate_condition(condition, path="entry"):
    if not isinstance(condition, dict):
        raise ValueError("%s must be an object" % path)
    node_type = condition.get("type")
    if node_type is not None:
        if node_type not in ("ALL", "ANY"):
            raise ValueError("%s type must be ALL or ANY" % path)
        children = condition.get("conditions")
        if not isinstance(children, list) or not children:
            raise ValueError("%s conditions must be non-empty" % path)
        for index, child in enumerate(children):
            _validate_condition(
                child,
                "%s.conditions[%d]" % (path, index),
            )
        return
    field = condition.get("field")
    operator = condition.get("op")
    if field not in ALLOWED_FIELDS:
        raise ValueError("unsupported strategy field: %s" % field)
    if operator not in ALLOWED_OPERATORS:
        raise ValueError("unsupported strategy operator: %s" % operator)
    expected = condition.get("value")
    if operator == "BETWEEN":
        if (
            not isinstance(expected, list)
            or len(expected) != 2
            or not all(
                isinstance(item, (int, float)) and math.isfinite(item)
                for item in expected
            )
        ):
            raise ValueError("%s BETWEEN value must contain two numbers" % path)
    if operator == "IN" and not isinstance(expected, list):
        raise ValueError("%s IN value must be a list" % path)
    if operator in ("GT", "GTE", "LT", "LTE"):
        if not isinstance(expected, (int, float)) or not math.isfinite(expected):
            raise ValueError("%s threshold must be finite" % path)


def validate_strategy_spec(value):
    if not isinstance(value, dict):
        raise ValueError("strategy spec must be an object")
    spec = copy.deepcopy(value)
    if spec.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("unsupported strategy schemaVersion")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,63}", spec.get("strategyId", "")):
        raise ValueError("invalid strategyId")
    expected_version = strategy_fingerprint(spec)
    if spec.get("specVersion") != expected_version:
        raise ValueError("strategy specVersion mismatch")
    _validate_condition(spec.get("entry"))

    position = spec.get("position") or {}
    allocation = _positive(position.get("allocationPct"), "allocationPct")
    maximum = _positive(position.get("maxPositions"), "maxPositions")
    lot_size = _positive(position.get("lotSize"), "lotSize")
    if not float(maximum).is_integer() or not float(lot_size).is_integer():
        raise ValueError("maxPositions and lotSize must be integers")
    if allocation * maximum > 100:
        raise ValueError("position budget cannot exceed 100 percent")

    exit_policy = spec.get("exit") or {}
    _positive(exit_policy.get("stopLossPct"), "stopLossPct")
    _positive(exit_policy.get("takeProfitPct"), "takeProfitPct")
    _positive(exit_policy.get("maxHoldingDays"), "maxHoldingDays")

    execution = spec.get("execution") or {}
    if execution.get("entryAt") != "NEXT_OPEN":
        raise ValueError("entryAt must be NEXT_OPEN")
    if execution.get("exitAt") != "NEXT_OPEN":
        raise ValueError("exitAt must be NEXT_OPEN")
    if execution.get("tPlusOne") is not True:
        raise ValueError("tPlusOne must be enabled")
    if (
        execution.get("rejectLimitUpBuy") is not True
        or execution.get("rejectLimitDownSell") is not True
    ):
        raise ValueError("price-limit fill guards must be enabled")
    if execution.get("feePolicy") != "A_SHARE_STANDARD_V1":
        raise ValueError("unsupported feePolicy")
    try:
        slippage = float(execution.get("slippageBps"))
    except (TypeError, ValueError):
        raise ValueError("slippageBps must be non-negative")
    if not math.isfinite(slippage) or slippage < 0:
        raise ValueError("slippageBps must be non-negative")

    score = spec.get("score") or {}
    if score.get("method") != "WEIGHTED_SUM":
        raise ValueError("unsupported score method")
    weights = score.get("weights") or {}
    expected_weight_keys = {
        "marketScore",
        "quantScore",
        "upProb",
        "expectedReturn",
    }
    if set(weights) != expected_weight_keys:
        raise ValueError("score weight keys are incomplete")
    weight_values = [float(weights[key]) for key in sorted(weights)]
    if (
        not weight_values
        or any(not math.isfinite(item) or item < 0 for item in weight_values)
        or abs(sum(weight_values) - 1) > 1e-9
    ):
        raise ValueError("score weights must sum to one")
    normalization = score.get("normalization") or {}
    minimum = _finite_number(
        normalization.get("expectedReturnMin"),
        "score normalization minimum",
    )
    maximum = _finite_number(
        normalization.get("expectedReturnMax"),
        "score normalization maximum",
    )
    if maximum <= minimum:
        raise ValueError("score normalization range is invalid")
    return spec


def load_strategy_spec(source, timeout=10):
    if re.match(r"^https?://", str(source)):
        with urllib.request.urlopen(source, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    else:
        with open(source, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    if isinstance(payload, dict) and "strategy" in payload:
        payload = payload["strategy"]
    return validate_strategy_spec(payload)
