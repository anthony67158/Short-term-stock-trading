export const STRATEGY_SPEC_SCHEMA_VERSION = 'strategy-spec.v1'

const ALLOWED_FIELDS = new Set([
  'amount',
  'mainRatio',
  'marketEnv.score',
  'marketScore',
  'pct',
  'quant.expRet',
  'quant.highConfFired',
  'quant.score',
  'quant.upProb',
  'speed',
  'turnover',
  'volRatio',
])

const ALLOWED_OPERATORS = new Set([
  'BETWEEN',
  'EQ',
  'GT',
  'GTE',
  'IN',
  'LT',
  'LTE',
  'NE',
])

function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override
  }
  const output = { ...(base || {}) }
  for (const [key, value] of Object.entries(override)) {
    output[key] = (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && base?.[key]
      && typeof base[key] === 'object'
      && !Array.isArray(base[key])
    )
      ? merge(base[key], value)
      : value
  }
  return output
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => key !== 'specVersion')
      .map((key) => [key, stableValue(value[key])]),
  )
}

function hashText(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function strategySpecFingerprint(spec) {
  return `strategy.${hashText(JSON.stringify(stableValue(spec || {})))}`
}

export function createDefaultStrategySpec(overrides = {}) {
  const spec = merge({
    schemaVersion: STRATEGY_SPEC_SCHEMA_VERSION,
    strategyId: 'market-quant-resonance',
    name: '市场量化共振',
    data: {
      timeframe: '1d',
      signalAt: 'CLOSE',
      minimumHistoryBars: 60,
      availability: 'POINT_IN_TIME',
    },
    universe: {
      excludeSt: true,
      excludeSuspended: true,
      minimumListingDays: 20,
      minimumAmount: 8e7,
    },
    marketRanking: {
      filters: {
        minPct: -6,
        maxPct: 8.8,
        minTurnover: 0.4,
        maxTurnover: 25,
        minVolRatio: 0.5,
        maxVolRatio: 8,
      },
      factorWeights: {
        fund: 0.3,
        volume: 0.15,
        momentum: 0.15,
        speed: 0.1,
        liquidity: 0.15,
        turnover: 0.15,
      },
      factors: {
        fund: {
          mainRatioFloor: -3,
          mainRatioSpan: 18,
          inflowScaleYi: 7,
        },
        volume: { left: 0.5, ideal: 2.2, right: 8 },
        momentum: { left: -3, ideal: 3.5, right: 8.8 },
        speed: { floor: -0.2, span: 1.6 },
        liquidity: { amountMultiple: 25 },
        turnover: { left: 0.4, ideal: 6, right: 25 },
      },
    },
    entry: {
      type: 'ALL',
      conditions: [
        { field: 'marketScore', op: 'GTE', value: 55 },
        { field: 'quant.score', op: 'GTE', value: 55 },
        { field: 'pct', op: 'BETWEEN', value: [-6, 8.8] },
        { field: 'volRatio', op: 'BETWEEN', value: [0.5, 8] },
      ],
    },
    score: {
      method: 'WEIGHTED_SUM',
      weights: {
        marketScore: 0.4,
        quantScore: 0.35,
        upProb: 0.15,
        expectedReturn: 0.1,
      },
      bonuses: {
        highConfidence: 5,
      },
      normalization: {
        expectedReturnMin: -5,
        expectedReturnMax: 5,
      },
    },
    position: {
      sizing: 'EQUAL_WEIGHT',
      allocationPct: 20,
      maxPositions: 5,
      lotSize: 100,
    },
    exit: {
      stopLossPct: 3,
      takeProfitPct: 6,
      maxHoldingDays: 5,
      signalExit: null,
    },
    execution: {
      entryAt: 'NEXT_OPEN',
      exitAt: 'NEXT_OPEN',
      tPlusOne: true,
      rejectLimitUpBuy: true,
      rejectLimitDownSell: true,
      slippageBps: 5,
      feePolicy: 'A_SHARE_STANDARD_V1',
    },
  }, overrides)
  if (Object.hasOwn(overrides, 'entry')) {
    spec.entry = structuredClone(overrides.entry)
  }
  delete spec.specVersion
  return spec
}

function positive(value, name) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name}必须为正数`)
  }
  return number
}

function validateCondition(condition, path = 'entry') {
  if (!condition || typeof condition !== 'object') {
    throw new Error(`${path}条件不能为空`)
  }
  if (condition.type != null) {
    if (!['ALL', 'ANY'].includes(condition.type)) {
      throw new Error(`${path}只支持ALL或ANY`)
    }
    if (!Array.isArray(condition.conditions) || !condition.conditions.length) {
      throw new Error(`${path}.conditions不能为空`)
    }
    condition.conditions.forEach((item, index) =>
      validateCondition(item, `${path}.conditions[${index}]`)
    )
    return
  }
  if (!ALLOWED_FIELDS.has(condition.field)) {
    throw new Error(`不支持的策略字段: ${condition.field}`)
  }
  if (!ALLOWED_OPERATORS.has(condition.op)) {
    throw new Error(`不支持的条件操作符: ${condition.op}`)
  }
  if (condition.op === 'BETWEEN') {
    if (
      !Array.isArray(condition.value)
      || condition.value.length !== 2
      || !condition.value.every((item) => Number.isFinite(Number(item)))
    ) {
      throw new Error(`${path}.value必须为两个有限数`)
    }
  }
  if (condition.op === 'IN' && !Array.isArray(condition.value)) {
    throw new Error(`${path}.value必须为数组`)
  }
  if (
    ['GT', 'GTE', 'LT', 'LTE'].includes(condition.op)
    && !Number.isFinite(Number(condition.value))
  ) {
    throw new Error(`${path}比较阈值必须为有限数`)
  }
}

export function compileStrategySpec(input) {
  const spec = structuredClone(input || {})
  if (spec.schemaVersion !== STRATEGY_SPEC_SCHEMA_VERSION) {
    throw new Error(`不支持的策略Schema: ${spec.schemaVersion || 'missing'}`)
  }
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(String(spec.strategyId || ''))) {
    throw new Error('strategyId格式无效')
  }
  if (!['CLOSE'].includes(spec.data?.signalAt)) {
    throw new Error('data.signalAt当前只支持CLOSE')
  }
  if (!['NEXT_OPEN'].includes(spec.execution?.entryAt)) {
    throw new Error('execution.entryAt当前只支持NEXT_OPEN')
  }
  positive(spec.data?.minimumHistoryBars, 'minimumHistoryBars')
  positive(spec.universe?.minimumListingDays, 'minimumListingDays')
  positive(spec.universe?.minimumAmount, 'minimumAmount')
  positive(spec.position?.lotSize, 'lotSize')
  positive(spec.position?.allocationPct, 'allocationPct')
  positive(spec.position?.maxPositions, 'maxPositions')
  if (
    !Number.isInteger(Number(spec.position.lotSize))
    || !Number.isInteger(Number(spec.position.maxPositions))
  ) {
    throw new Error('lotSize和maxPositions必须为整数')
  }
  if (
    Number(spec.position.allocationPct)
      * Number(spec.position.maxPositions) > 100
  ) {
    throw new Error('仓位预算不能超过100%')
  }
  positive(spec.exit?.stopLossPct, 'stopLossPct')
  positive(spec.exit?.takeProfitPct, 'takeProfitPct')
  positive(spec.exit?.maxHoldingDays, 'maxHoldingDays')
  const slippage = Number(spec.execution?.slippageBps)
  if (!Number.isFinite(slippage) || slippage < 0) {
    throw new Error('slippageBps必须为非负有限数')
  }
  if (spec.execution?.tPlusOne !== true) {
    throw new Error('A股策略必须启用T+1')
  }
  if (
    spec.execution?.rejectLimitUpBuy !== true
    || spec.execution?.rejectLimitDownSell !== true
  ) {
    throw new Error('A股策略必须启用涨跌停不可成交闸门')
  }
  if (spec.execution?.feePolicy !== 'A_SHARE_STANDARD_V1') {
    throw new Error('feePolicy当前只支持A_SHARE_STANDARD_V1')
  }
  if (spec.score?.method !== 'WEIGHTED_SUM') {
    throw new Error('score.method当前只支持WEIGHTED_SUM')
  }
  const weights = Object.values(spec.score?.weights || {}).map(Number)
  if (
    !weights.length
    || weights.some((value) => !Number.isFinite(value) || value < 0)
    || Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) > 1e-9
  ) {
    throw new Error('评分权重之和必须为1')
  }
  const marketWeights = Object.values(
    spec.marketRanking?.factorWeights || {},
  ).map(Number)
  if (
    !marketWeights.length
    || marketWeights.some((value) => !Number.isFinite(value) || value < 0)
    || Math.abs(
      marketWeights.reduce((sum, value) => sum + value, 0) - 1
    ) > 1e-9
  ) {
    throw new Error('市场因子权重之和必须为1')
  }
  const filters = spec.marketRanking?.filters || {}
  for (const key of [
    'minPct',
    'maxPct',
    'minTurnover',
    'maxTurnover',
    'minVolRatio',
    'maxVolRatio',
  ]) {
    if (!Number.isFinite(Number(filters[key]))) {
      throw new Error(`marketRanking.filters.${key}必须为有限数`)
    }
  }
  validateCondition(spec.entry)
  spec.specVersion = strategySpecFingerprint(spec)
  return spec
}

export function getActiveStrategySpec() {
  return compileStrategySpec(createDefaultStrategySpec())
}

function fieldValue(context, field) {
  return field.split('.').reduce((current, key) => current?.[key], context)
}

function rulePassed(actual, op, expected) {
  if (actual == null || (typeof actual === 'number' && !Number.isFinite(actual))) {
    return { passed: false, reason: 'MISSING_VALUE' }
  }
  switch (op) {
    case 'EQ': return { passed: actual === expected }
    case 'NE': return { passed: actual !== expected }
    case 'GT': return { passed: Number(actual) > Number(expected) }
    case 'GTE': return { passed: Number(actual) >= Number(expected) }
    case 'LT': return { passed: Number(actual) < Number(expected) }
    case 'LTE': return { passed: Number(actual) <= Number(expected) }
    case 'IN': return { passed: expected.includes(actual) }
    case 'BETWEEN': {
      const value = Number(actual)
      return {
        passed: Number.isFinite(value)
          && value >= Number(expected[0])
          && value <= Number(expected[1]),
      }
    }
    default: return { passed: false, reason: 'UNSUPPORTED_OPERATOR' }
  }
}

function evaluateNode(node, context) {
  if (node.type) {
    const children = node.conditions.map((item) => evaluateNode(item, context))
    return {
      passed: node.type === 'ALL'
        ? children.every((item) => item.passed)
        : children.some((item) => item.passed),
      matchedRules: children.flatMap((item) => item.matchedRules),
      failedRules: children.flatMap((item) => item.failedRules),
    }
  }
  const actual = fieldValue(context, node.field)
  const outcome = rulePassed(actual, node.op, node.value)
  const record = {
    field: node.field,
    op: node.op,
    expected: node.value,
    actual: actual ?? null,
    reason: outcome.reason || null,
  }
  return {
    passed: outcome.passed,
    matchedRules: outcome.passed ? [record] : [],
    failedRules: outcome.passed ? [] : [record],
  }
}

export function evaluateStrategySignal(input, context = {}) {
  const spec = compileStrategySpec(input)
  const result = evaluateNode(spec.entry, context)
  return {
    strategyId: spec.strategyId,
    specVersion: spec.specVersion,
    passed: result.passed,
    matchedRules: result.matchedRules,
    failedRules: result.failedRules,
  }
}
