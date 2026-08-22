"""Validated Python adapter for the shared StrategySpec v2 contract."""

import copy
import json
import math
import os
import re
import urllib.request

from strategy_contract import strategy_fingerprint


SCHEMA_VERSION = "strategy-spec.v2"
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCHEMA_PATH = os.path.join(
    PROJECT_ROOT,
    "shared",
    "contracts",
    "strategy-spec.v2.schema.json",
)

FAMILIES = {
    "TREND_BREAKOUT",
    "CROSS_SECTIONAL_MOMENTUM",
    "RANGE_MEAN_REVERSION",
    "MULTI_FACTOR_RANKING",
    "DEFENSIVE_EXIT",
}
PURPOSES = {"ENTRY", "RANKING", "POSITION_MANAGEMENT", "EXIT"}
REGIMES = {
    "TREND_STRONG",
    "RANGE",
    "TRANSITION",
    "RISK_OFF",
    "UNKNOWN",
}
TIMEFRAMES = {"1d", "5m"}
EXECUTION_TIMEFRAMES = {"NEXT_OPEN", "NEXT_BAR_OPEN"}
OPERATORS = {"BETWEEN", "EQ", "GT", "GTE", "IN", "LT", "LTE", "NE"}
ALLOWED_FIELDS = {
    "account.hasBasePosition",
    "amount",
    "fund.mainRatio",
    "liquidity.adv20",
    "mainRatio",
    "market.regime",
    "marketEnv.score",
    "marketRegime",
    "marketScore",
    "pct",
    "quant.expRet",
    "quant.highConfFired",
    "quant.score",
    "quant.upProb",
    "relativeStrength20",
    "sector.breadth",
    "speed",
    "technical.atrPct",
    "technical.atrStopBroken",
    "technical.bollPct",
    "technical.donchianBreakout",
    "technical.maSlope20",
    "technical.rsi6",
    "technical.structureBreak",
    "technical.vwapDeviationPct",
    "turnover",
    "volRatio",
}
REQUIRED_CAPITAL_SCENARIOS = {100000, 500000, 1000000, 5000000}
REQUIRED_SLIPPAGE_SCENARIOS = {5, 10, 20}


def strategy_fingerprint_v2(spec):
    return strategy_fingerprint(spec)


def _number(value, path):
    if isinstance(value, bool):
        raise ValueError("%s must be finite" % path)
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError("%s must be finite" % path)
    if not math.isfinite(number):
        raise ValueError("%s must be finite" % path)
    return number


def _positive(value, path):
    number = _number(value, path)
    if number <= 0:
        raise ValueError("%s must be positive" % path)
    return number


def _integer(value, path):
    number = _positive(value, path)
    if not number.is_integer():
        raise ValueError("%s must be an integer" % path)
    return int(number)


def _percentage(value, path, maximum=100.0, allow_zero=True):
    number = _number(value, path)
    minimum_invalid = number < 0 if allow_zero else number <= 0
    if minimum_invalid or number > maximum:
        raise ValueError("%s is outside its allowed range" % path)
    return number


def _unique_enum(values, allowed, path):
    if not isinstance(values, list) or not values:
        raise ValueError("%s must be a non-empty list" % path)
    if len(set(values)) != len(values):
        raise ValueError("%s must not contain duplicates" % path)
    invalid = [value for value in values if value not in allowed]
    if invalid:
        raise ValueError("%s contains unsupported values" % path)


def _validate_condition(node, path="entry"):
    if not isinstance(node, dict):
        raise ValueError("%s must be an object" % path)
    if node.get("type") is not None:
        if node["type"] not in ("ALL", "ANY"):
            raise ValueError("%s type must be ALL or ANY" % path)
        conditions = node.get("conditions")
        if not isinstance(conditions, list) or not conditions:
            raise ValueError("%s conditions must be non-empty" % path)
        for index, condition in enumerate(conditions):
            _validate_condition(
                condition,
                "%s.conditions[%d]" % (path, index),
            )
        return
    field = node.get("field")
    operator = node.get("op")
    if field not in ALLOWED_FIELDS:
        raise ValueError("unsupported strategy field: %s" % field)
    if operator not in OPERATORS:
        raise ValueError("unsupported strategy operator: %s" % operator)
    expected = node.get("value")
    if operator == "BETWEEN":
        if not isinstance(expected, list) or len(expected) != 2:
            raise ValueError("%s BETWEEN requires two numbers" % path)
        lower = _number(expected[0], "%s.value[0]" % path)
        upper = _number(expected[1], "%s.value[1]" % path)
        if lower > upper:
            raise ValueError("%s BETWEEN values must be ascending" % path)
    elif operator == "IN":
        if not isinstance(expected, list) or not expected:
            raise ValueError("%s IN requires a non-empty list" % path)
    elif operator in ("GT", "GTE", "LT", "LTE"):
        _number(expected, "%s.value" % path)


def _required_scenarios(values, required, path):
    if not isinstance(values, list) or not values:
        raise ValueError("%s must be a non-empty list" % path)
    numbers = [_positive(value, path) for value in values]
    if len(set(numbers)) != len(numbers):
        raise ValueError("%s must not contain duplicates" % path)
    if not required.issubset(set(numbers)):
        raise ValueError("%s does not cover required scenarios" % path)


def _validate_dependencies(dependencies):
    if not isinstance(dependencies, list):
        raise ValueError("modelDependencies must be a list")
    seen = set()
    for dependency in dependencies:
        if not isinstance(dependency, dict):
            raise ValueError("modelDependencies entries must be objects")
        identifier = str(dependency.get("id", "")).strip()
        if not identifier or identifier in seen:
            raise ValueError("modelDependencies id is invalid or duplicated")
        seen.add(identifier)
        if dependency.get("type") not in ("MODEL", "FACTOR_SET", "NONE"):
            raise ValueError("modelDependencies type is invalid")
        if not str(dependency.get("version", "")).strip():
            raise ValueError("modelDependencies version is required")
        if not isinstance(dependency.get("required"), bool):
            raise ValueError("modelDependencies required must be boolean")
        feature_count = dependency.get("featureCount")
        if feature_count is not None:
            if (
                isinstance(feature_count, bool)
                or not isinstance(feature_count, int)
                or feature_count < 0
            ):
                raise ValueError("modelDependencies featureCount is invalid")
        if identifier == "lgb-score-36" and feature_count != 36:
            raise ValueError("production lgb-score-36 must remain 36 features")


def _validate_score(score):
    if not isinstance(score, dict) or score.get("method") != "WEIGHTED_SUM":
        raise ValueError("score.method must be WEIGHTED_SUM")
    weights = score.get("weights")
    if not isinstance(weights, dict) or not weights:
        raise ValueError("score.weights must be non-empty")
    values = [_number(value, "score.weights") for value in weights.values()]
    if any(value < 0 for value in values) or abs(sum(values) - 1.0) > 1e-9:
        raise ValueError("score.weights must sum to one")


def _required_top_level_fields():
    with open(SCHEMA_PATH, encoding="utf-8") as handle:
        return set(json.load(handle)["required"])


def validate_strategy_spec_v2(value):
    if not isinstance(value, dict):
        raise ValueError("strategy spec must be an object")
    spec = copy.deepcopy(value)
    if set(spec) != _required_top_level_fields():
        raise ValueError("strategy spec top-level fields do not match schema")
    if spec.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("unsupported strategy schemaVersion")
    if not re.fullmatch(
        r"[a-z0-9][a-z0-9-]{2,63}",
        str(spec.get("strategyId", "")),
    ):
        raise ValueError("invalid strategyId")
    name = str(spec.get("name", "")).strip()
    if not name or len(name) > 80:
        raise ValueError("invalid strategy name")
    if spec.get("family") not in FAMILIES:
        raise ValueError("invalid strategy family")
    if spec.get("purpose") not in PURPOSES:
        raise ValueError("invalid strategy purpose")
    horizon = spec.get("horizon") or {}
    if horizon.get("unit") not in ("MINUTE", "TRADING_DAY"):
        raise ValueError("invalid strategy horizon unit")
    _integer(horizon.get("value"), "horizon.value")
    _unique_enum(spec.get("eligibleRegimes"), REGIMES, "eligibleRegimes")

    signal_timeframe = spec.get("signalTimeframe")
    execution_timeframe = spec.get("executionTimeframe")
    if signal_timeframe not in TIMEFRAMES:
        raise ValueError("invalid signalTimeframe")
    if execution_timeframe not in EXECUTION_TIMEFRAMES:
        raise ValueError("invalid executionTimeframe")
    expected_execution = (
        "NEXT_OPEN" if signal_timeframe == "1d" else "NEXT_BAR_OPEN"
    )
    if execution_timeframe != expected_execution:
        raise ValueError("signal and execution timeframe mismatch")

    data = spec.get("data") or {}
    if data.get("signalPrice") != "QFQ":
        raise ValueError("data.signalPrice must be QFQ")
    if data.get("executionPrice") != "RAW":
        raise ValueError("data.executionPrice must be RAW")
    if (
        data.get("pointInTime") is not True
        or data.get("completedBarsOnly") is not True
    ):
        raise ValueError("data must be point-in-time completed bars")
    _integer(data.get("minimumHistoryBars"), "data.minimumHistoryBars")

    _validate_condition(spec.get("entry"))
    exit_policy = spec.get("exit") or {}
    _positive(exit_policy.get("stopLossPct"), "exit.stopLossPct")
    _positive(exit_policy.get("takeProfitPct"), "exit.takeProfitPct")
    _integer(exit_policy.get("maxHoldingBars"), "exit.maxHoldingBars")
    if exit_policy.get("signal") is not None:
        _validate_condition(exit_policy["signal"], "exit.signal")

    trailing = spec.get("trailingStop") or {}
    if not isinstance(trailing.get("enabled"), bool):
        raise ValueError("trailingStop.enabled must be boolean")
    _percentage(trailing.get("activationPct"), "trailingStop.activationPct")
    _positive(trailing.get("atrMultiple"), "trailingStop.atrMultiple")

    sizing = spec.get("positionSizing") or {}
    if sizing.get("method") not in ("RISK_BUDGET", "EQUAL_WEIGHT"):
        raise ValueError("invalid positionSizing.method")
    _percentage(
        sizing.get("riskPerTradePct"),
        "positionSizing.riskPerTradePct",
        maximum=2,
        allow_zero=False,
    )
    allocation = _percentage(
        sizing.get("allocationPct"),
        "positionSizing.allocationPct",
        allow_zero=False,
    )
    maximum_positions = _integer(
        sizing.get("maxPositions"),
        "positionSizing.maxPositions",
    )
    _integer(sizing.get("lotSize"), "positionSizing.lotSize")
    if allocation * maximum_positions > 100:
        raise ValueError("positionSizing budget exceeds 100 percent")

    risk = spec.get("riskLimits") or {}
    for field in (
        "maxPortfolioExposurePct",
        "maxStockWeightPct",
        "maxSectorExposurePct",
    ):
        _percentage(risk.get(field), "riskLimits.%s" % field)
    _percentage(
        risk.get("maxLossPct"),
        "riskLimits.maxLossPct",
        maximum=20,
        allow_zero=False,
    )
    if not isinstance(risk.get("allowRiskIncrease"), bool):
        raise ValueError("riskLimits.allowRiskIncrease must be boolean")

    liquidity = spec.get("liquidityLimits") or {}
    _positive(liquidity.get("minimumAmount"), "liquidityLimits.minimumAmount")
    _positive(liquidity.get("minimumAdv20"), "liquidityLimits.minimumAdv20")
    _percentage(
        liquidity.get("maximumParticipationRate"),
        "liquidityLimits.maximumParticipationRate",
        maximum=0.2,
        allow_zero=False,
    )
    _percentage(
        liquidity.get("maximumSpreadBps"),
        "liquidityLimits.maximumSpreadBps",
        maximum=100,
    )

    _unique_enum(spec.get("benchmark"), {"CSI300", "CSI1000"}, "benchmark")
    capacity = spec.get("capacityAssumptions") or {}
    _required_scenarios(
        capacity.get("capitalScenarios"),
        REQUIRED_CAPITAL_SCENARIOS,
        "capacityAssumptions.capitalScenarios",
    )
    _required_scenarios(
        capacity.get("slippageScenariosBps"),
        REQUIRED_SLIPPAGE_SCENARIOS,
        "capacityAssumptions.slippageScenariosBps",
    )
    _percentage(
        capacity.get("baseParticipationRate"),
        "capacityAssumptions.baseParticipationRate",
        maximum=0.2,
        allow_zero=False,
    )
    _validate_dependencies(spec.get("modelDependencies"))

    execution = spec.get("execution") or {}
    if execution.get("feePolicy") != "A_SHARE_STANDARD_V1":
        raise ValueError("invalid execution.feePolicy")
    for field in (
        "tPlusOne",
        "rejectLimitUpBuy",
        "rejectLimitDownSell",
        "carryUnfilledExit",
    ):
        if execution.get(field) is not True:
            raise ValueError("execution.%s must be enabled" % field)
    _percentage(
        execution.get("baseSlippageBps"),
        "execution.baseSlippageBps",
        maximum=100,
    )
    _percentage(
        execution.get("spreadBps"),
        "execution.spreadBps",
        maximum=100,
    )
    _validate_score(spec.get("score"))

    expected_version = strategy_fingerprint_v2(spec)
    if spec.get("specVersion") != expected_version:
        raise ValueError("strategy specVersion mismatch")
    return spec


def load_strategy_spec_v2(source, timeout=10):
    if re.match(r"^https?://", str(source)):
        with urllib.request.urlopen(source, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    else:
        with open(source, encoding="utf-8") as handle:
            payload = json.load(handle)
    if isinstance(payload, dict) and "strategy" in payload:
        payload = payload["strategy"]
    return validate_strategy_spec_v2(payload)
