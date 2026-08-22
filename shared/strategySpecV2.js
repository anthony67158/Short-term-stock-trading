import { strategySpecFingerprint } from './strategySpec.js'

export const STRATEGY_SPEC_V2_SCHEMA_VERSION = 'strategy-spec.v2'

export const STRATEGY_FAMILIES = Object.freeze([
  'TREND_BREAKOUT',
  'CROSS_SECTIONAL_MOMENTUM',
  'RANGE_MEAN_REVERSION',
  'MULTI_FACTOR_RANKING',
  'DEFENSIVE_EXIT',
])

export const STRATEGY_REGIMES = Object.freeze([
  'TREND_STRONG',
  'RANGE',
  'TRANSITION',
  'RISK_OFF',
  'UNKNOWN',
])

const PURPOSES = new Set([
  'ENTRY',
  'RANKING',
  'POSITION_MANAGEMENT',
  'EXIT',
])
const TIMEFRAMES = new Set(['1d', '5m'])
const EXECUTION_TIMEFRAMES = new Set(['NEXT_OPEN', 'NEXT_BAR_OPEN'])
const OPERATORS = new Set([
  'BETWEEN',
  'EQ',
  'GT',
  'GTE',
  'IN',
  'LT',
  'LTE',
  'NE',
])
const ALLOWED_FIELDS = new Set([
  'account.hasBasePosition',
  'amount',
  'fund.mainRatio',
  'liquidity.adv20',
  'mainRatio',
  'market.regime',
  'marketEnv.score',
  'marketRegime',
  'marketScore',
  'pct',
  'quant.expRet',
  'quant.highConfFired',
  'quant.score',
  'quant.upProb',
  'relativeStrength20',
  'sector.breadth',
  'speed',
  'technical.atrPct',
  'technical.atrStopBroken',
  'technical.bollPct',
  'technical.donchianBreakout',
  'technical.maSlope20',
  'technical.rsi6',
  'technical.structureBreak',
  'technical.vwapDeviationPct',
  'turnover',
  'volRatio',
])
const REQUIRED_CAPITAL_SCENARIOS = [100000, 500000, 1000000, 5000000]
const REQUIRED_SLIPPAGE_SCENARIOS = [5, 10, 20]
const REQUIRED_TOP_LEVEL_FIELDS = new Set([
  'benchmark',
  'capacityAssumptions',
  'data',
  'eligibleRegimes',
  'entry',
  'execution',
  'executionTimeframe',
  'exit',
  'family',
  'horizon',
  'liquidityLimits',
  'modelDependencies',
  'name',
  'positionSizing',
  'purpose',
  'riskLimits',
  'schemaVersion',
  'score',
  'signalTimeframe',
  'specVersion',
  'strategyId',
  'trailingStop',
])

function clone(value) {
  return structuredClone(value)
}

function finite(value, path) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${path}必须为有限数`)
  return number
}

function positive(value, path) {
  const number = finite(value, path)
  if (number <= 0) throw new Error(`${path}必须为正数`)
  return number
}

function integer(value, path) {
  const number = positive(value, path)
  if (!Number.isInteger(number)) throw new Error(`${path}必须为整数`)
  return number
}

function percentage(value, path, maximum = 100, allowZero = true) {
  const number = finite(value, path)
  if (
    number > maximum
    || (allowZero ? number < 0 : number <= 0)
  ) {
    throw new Error(`${path}超出允许范围`)
  }
  return number
}

function ensureUniqueArray(value, allowed, path) {
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`${path}不能为空`)
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${path}不能重复`)
  }
  for (const item of value) {
    if (!allowed.has(item)) throw new Error(`${path}包含不支持的值: ${item}`)
  }
}

function validateCondition(node, path = 'entry') {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${path}必须为条件对象`)
  }
  if (node.type != null) {
    if (!['ALL', 'ANY'].includes(node.type)) {
      throw new Error(`${path}.type只支持ALL或ANY`)
    }
    if (!Array.isArray(node.conditions) || !node.conditions.length) {
      throw new Error(`${path}.conditions不能为空`)
    }
    node.conditions.forEach((condition, index) =>
      validateCondition(condition, `${path}.conditions[${index}]`)
    )
    return
  }
  if (!ALLOWED_FIELDS.has(node.field)) {
    throw new Error(`不支持的策略字段: ${node.field}`)
  }
  if (!OPERATORS.has(node.op)) {
    throw new Error(`不支持的条件操作符: ${node.op}`)
  }
  if (node.op === 'BETWEEN') {
    if (
      !Array.isArray(node.value)
      || node.value.length !== 2
      || node.value.some((item) => !Number.isFinite(Number(item)))
      || Number(node.value[0]) > Number(node.value[1])
    ) {
      throw new Error(`${path}.value必须为递增的两个有限数`)
    }
  } else if (node.op === 'IN') {
    if (!Array.isArray(node.value) || !node.value.length) {
      throw new Error(`${path}.value必须为非空数组`)
    }
  } else if (
    ['GT', 'GTE', 'LT', 'LTE'].includes(node.op)
    && !Number.isFinite(Number(node.value))
  ) {
    throw new Error(`${path}.value必须为有限数`)
  }
}

function validateRequiredScenarios(actual, required, path) {
  if (!Array.isArray(actual) || !actual.length) {
    throw new Error(`${path}不能为空`)
  }
  const numbers = actual.map((item) => positive(item, path))
  if (new Set(numbers).size !== numbers.length) {
    throw new Error(`${path}不能重复`)
  }
  if (required.some((item) => !numbers.includes(item))) {
    throw new Error(`${path}必须覆盖${required.join('/')}`)
  }
}

function validateModelDependencies(value) {
  if (!Array.isArray(value)) {
    throw new Error('modelDependencies必须为数组')
  }
  const seen = new Set()
  for (const dependency of value) {
    const id = String(dependency?.id || '').trim()
    if (!id || seen.has(id)) throw new Error('modelDependencies.id无效或重复')
    seen.add(id)
    if (!['MODEL', 'FACTOR_SET', 'NONE'].includes(dependency.type)) {
      throw new Error(`modelDependencies.${id}.type无效`)
    }
    if (!String(dependency.version || '').trim()) {
      throw new Error(`modelDependencies.${id}.version不能为空`)
    }
    if (typeof dependency.required !== 'boolean') {
      throw new Error(`modelDependencies.${id}.required必须为布尔值`)
    }
    if (
      dependency.featureCount != null
      && (!Number.isInteger(Number(dependency.featureCount))
        || Number(dependency.featureCount) < 0)
    ) {
      throw new Error(`modelDependencies.${id}.featureCount无效`)
    }
    if (
      dependency.id === 'lgb-score-36'
      && Number(dependency.featureCount) !== 36
    ) {
      throw new Error('生产lgb-score-36必须保持36维特征口径')
    }
  }
}

function validateScore(score) {
  if (score?.method !== 'WEIGHTED_SUM') {
    throw new Error('score.method当前只支持WEIGHTED_SUM')
  }
  const weights = Object.values(score?.weights || {}).map(Number)
  if (
    !weights.length
    || weights.some((value) => !Number.isFinite(value) || value < 0)
    || Math.abs(weights.reduce((sum, value) => sum + value, 0) - 1) > 1e-9
  ) {
    throw new Error('score.weights之和必须为1')
  }
}

function fieldValue(context, field) {
  return field.split('.').reduce((current, key) => current?.[key], context)
}

function rulePassed(actual, operator, expected) {
  if (
    actual == null
    || (typeof actual === 'number' && !Number.isFinite(actual))
  ) {
    return { passed: false, reason: 'MISSING_VALUE' }
  }
  if (operator === 'EQ') return { passed: actual === expected }
  if (operator === 'NE') return { passed: actual !== expected }
  if (operator === 'IN') return { passed: expected.includes(actual) }
  if (operator === 'BETWEEN') {
    const number = Number(actual)
    return {
      passed: Number.isFinite(number)
        && number >= Number(expected[0])
        && number <= Number(expected[1]),
    }
  }
  const number = Number(actual)
  const threshold = Number(expected)
  if (!Number.isFinite(number) || !Number.isFinite(threshold)) {
    return { passed: false, reason: 'INVALID_NUMBER' }
  }
  if (operator === 'GT') return { passed: number > threshold }
  if (operator === 'GTE') return { passed: number >= threshold }
  if (operator === 'LT') return { passed: number < threshold }
  if (operator === 'LTE') return { passed: number <= threshold }
  return { passed: false, reason: 'UNSUPPORTED_OPERATOR' }
}

function evaluateNode(node, context) {
  if (node.type) {
    const children = node.conditions.map(
      (condition) => evaluateNode(condition, context),
    )
    return {
      passed: node.type === 'ALL'
        ? children.every((item) => item.passed)
        : children.some((item) => item.passed),
      matchedRules: children.flatMap((item) => item.matchedRules),
      failedRules: children.flatMap((item) => item.failedRules),
    }
  }
  const actual = fieldValue(context, node.field)
  const result = rulePassed(actual, node.op, node.value)
  const record = {
    field: node.field,
    op: node.op,
    expected: node.value,
    actual: actual ?? null,
    reason: result.reason || null,
  }
  return {
    passed: result.passed,
    matchedRules: result.passed ? [record] : [],
    failedRules: result.passed ? [] : [record],
  }
}

export function compileStrategySpecV2(input) {
  const spec = clone(input || {})
  const fields = Object.keys(spec)
  const requiredInputFields = [...REQUIRED_TOP_LEVEL_FIELDS]
    .filter((field) => field !== 'specVersion')
  const unexpectedFields = fields.filter(
    (field) => !REQUIRED_TOP_LEVEL_FIELDS.has(field),
  )
  const missingFields = requiredInputFields.filter(
    (field) => !Object.hasOwn(spec, field),
  )
  if (
    unexpectedFields.length
    || missingFields.length
    || ![requiredInputFields.length, REQUIRED_TOP_LEVEL_FIELDS.size]
      .includes(fields.length)
  ) {
    throw new Error(
      `策略顶层字段与StrategySpec v2不一致`
      + `（缺少:${missingFields.join(',') || '无'}`
      + `；多余:${unexpectedFields.join(',') || '无'}）`,
    )
  }
  if (spec.schemaVersion !== STRATEGY_SPEC_V2_SCHEMA_VERSION) {
    throw new Error(`不支持的策略Schema: ${spec.schemaVersion || 'missing'}`)
  }
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(String(spec.strategyId || ''))) {
    throw new Error('strategyId格式无效')
  }
  if (!String(spec.name || '').trim() || String(spec.name).length > 80) {
    throw new Error('name必须为1到80个字符')
  }
  if (!STRATEGY_FAMILIES.includes(spec.family)) {
    throw new Error(`family无效: ${spec.family}`)
  }
  if (!PURPOSES.has(spec.purpose)) {
    throw new Error(`purpose无效: ${spec.purpose}`)
  }
  integer(spec.horizon?.value, 'horizon.value')
  if (!['MINUTE', 'TRADING_DAY'].includes(spec.horizon?.unit)) {
    throw new Error('horizon.unit无效')
  }
  ensureUniqueArray(
    spec.eligibleRegimes,
    new Set(STRATEGY_REGIMES),
    'eligibleRegimes',
  )
  if (!TIMEFRAMES.has(spec.signalTimeframe)) {
    throw new Error('signalTimeframe只支持1d或5m')
  }
  if (!EXECUTION_TIMEFRAMES.has(spec.executionTimeframe)) {
    throw new Error('executionTimeframe无效')
  }
  if (
    (spec.signalTimeframe === '1d'
      && spec.executionTimeframe !== 'NEXT_OPEN')
    || (spec.signalTimeframe === '5m'
      && spec.executionTimeframe !== 'NEXT_BAR_OPEN')
  ) {
    throw new Error('信号与执行周期不匹配')
  }
  if (spec.data?.signalPrice !== 'QFQ') {
    throw new Error('data.signalPrice必须为QFQ')
  }
  if (spec.data?.executionPrice !== 'RAW') {
    throw new Error('data.executionPrice必须为RAW')
  }
  if (
    spec.data?.pointInTime !== true
    || spec.data?.completedBarsOnly !== true
  ) {
    throw new Error('数据必须为point-in-time且只使用完成K线')
  }
  integer(spec.data?.minimumHistoryBars, 'data.minimumHistoryBars')
  validateCondition(spec.entry)
  if (spec.exit?.signal != null) validateCondition(spec.exit.signal, 'exit.signal')
  positive(spec.exit?.stopLossPct, 'exit.stopLossPct')
  positive(spec.exit?.takeProfitPct, 'exit.takeProfitPct')
  integer(spec.exit?.maxHoldingBars, 'exit.maxHoldingBars')
  if (typeof spec.trailingStop?.enabled !== 'boolean') {
    throw new Error('trailingStop.enabled必须为布尔值')
  }
  percentage(
    spec.trailingStop?.activationPct,
    'trailingStop.activationPct',
  )
  positive(spec.trailingStop?.atrMultiple, 'trailingStop.atrMultiple')
  if (!['RISK_BUDGET', 'EQUAL_WEIGHT'].includes(spec.positionSizing?.method)) {
    throw new Error('positionSizing.method无效')
  }
  percentage(
    spec.positionSizing?.riskPerTradePct,
    'positionSizing.riskPerTradePct',
    2,
    false,
  )
  const allocation = percentage(
    spec.positionSizing?.allocationPct,
    'positionSizing.allocationPct',
    100,
    false,
  )
  const maximumPositions = integer(
    spec.positionSizing?.maxPositions,
    'positionSizing.maxPositions',
  )
  integer(spec.positionSizing?.lotSize, 'positionSizing.lotSize')
  if (allocation * maximumPositions > 100) {
    throw new Error('positionSizing总仓位预算不能超过100%')
  }
  percentage(
    spec.riskLimits?.maxPortfolioExposurePct,
    'riskLimits.maxPortfolioExposurePct',
  )
  percentage(
    spec.riskLimits?.maxStockWeightPct,
    'riskLimits.maxStockWeightPct',
  )
  percentage(
    spec.riskLimits?.maxSectorExposurePct,
    'riskLimits.maxSectorExposurePct',
  )
  percentage(
    spec.riskLimits?.maxLossPct,
    'riskLimits.maxLossPct',
    20,
    false,
  )
  if (typeof spec.riskLimits?.allowRiskIncrease !== 'boolean') {
    throw new Error('riskLimits.allowRiskIncrease必须为布尔值')
  }
  positive(
    spec.liquidityLimits?.minimumAmount,
    'liquidityLimits.minimumAmount',
  )
  positive(
    spec.liquidityLimits?.minimumAdv20,
    'liquidityLimits.minimumAdv20',
  )
  percentage(
    spec.liquidityLimits?.maximumParticipationRate,
    'liquidityLimits.maximumParticipationRate',
    0.2,
    false,
  )
  percentage(
    spec.liquidityLimits?.maximumSpreadBps,
    'liquidityLimits.maximumSpreadBps',
    100,
  )
  ensureUniqueArray(
    spec.benchmark,
    new Set(['CSI300', 'CSI1000']),
    'benchmark',
  )
  validateRequiredScenarios(
    spec.capacityAssumptions?.capitalScenarios,
    REQUIRED_CAPITAL_SCENARIOS,
    'capacityAssumptions.capitalScenarios',
  )
  validateRequiredScenarios(
    spec.capacityAssumptions?.slippageScenariosBps,
    REQUIRED_SLIPPAGE_SCENARIOS,
    'capacityAssumptions.slippageScenariosBps',
  )
  percentage(
    spec.capacityAssumptions?.baseParticipationRate,
    'capacityAssumptions.baseParticipationRate',
    0.2,
    false,
  )
  validateModelDependencies(spec.modelDependencies)
  if (spec.execution?.feePolicy !== 'A_SHARE_STANDARD_V1') {
    throw new Error('execution.feePolicy无效')
  }
  for (const key of [
    'tPlusOne',
    'rejectLimitUpBuy',
    'rejectLimitDownSell',
    'carryUnfilledExit',
  ]) {
    if (spec.execution?.[key] !== true) {
      throw new Error(`execution.${key}必须启用`)
    }
  }
  percentage(
    spec.execution?.baseSlippageBps,
    'execution.baseSlippageBps',
    100,
  )
  percentage(
    spec.execution?.spreadBps,
    'execution.spreadBps',
    100,
  )
  validateScore(spec.score)

  const expectedVersion = strategySpecFingerprint(spec)
  if (spec.specVersion && spec.specVersion !== expectedVersion) {
    throw new Error('strategy specVersion与内容不一致')
  }
  spec.specVersion = expectedVersion
  return spec
}

export function evaluateStrategySignalV2(input, context = {}) {
  const spec = compileStrategySpecV2(input)
  const marketRegime = String(
    context.marketRegime
      || context.market?.regime
      || context.marketEnv?.regime
      || 'UNKNOWN',
  )
  const regimeEligible = spec.eligibleRegimes.includes(marketRegime)
  const rules = evaluateNode(spec.entry, {
    ...context,
    marketRegime,
    market: {
      ...(context.market || {}),
      regime: marketRegime,
    },
  })
  return {
    strategyId: spec.strategyId,
    specVersion: spec.specVersion,
    family: spec.family,
    passed: regimeEligible && rules.passed,
    regimeEligible,
    reason: regimeEligible
      ? (rules.passed ? null : 'ENTRY_RULES_FAILED')
      : 'REGIME_NOT_ELIGIBLE',
    matchedRules: rules.matchedRules,
    failedRules: rules.failedRules,
  }
}
