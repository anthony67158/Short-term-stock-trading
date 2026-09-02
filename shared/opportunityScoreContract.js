export const OPPORTUNITY_SCORE_FEATURE_SCHEMA_VERSION =
  'opportunity-score-feature.v1'
export const OPPORTUNITY_SCORE_SCHEMA_VERSION =
  'opportunity-score.v1'

const CATEGORIES = Object.freeze({
  formula: [
    'TAIL_REVERSAL',
    'INTRADAY_VWAP_PULLBACK',
    'INTRADAY_ACCUMULATION',
    'CLOSE_TREND_PULLBACK',
    'CLOSE_SQUEEZE',
    'UNKNOWN',
  ],
  mode: ['INTRADAY', 'CLOSE', 'UNKNOWN'],
  priceType: [
    'PULLBACK_WATCH',
    'BREAKOUT_WATCH',
    'UNKNOWN',
  ],
  market: ['STANDARD', 'CAUTIOUS', 'BLOCKED', 'UNKNOWN'],
  sector: [
    'ACCUMULATION',
    'STARTUP',
    'ACCELERATION',
    'DIVERGENCE',
    'RETREAT',
    'UNKNOWN',
  ],
  sectorAction: [
    'LAYOUT',
    'WAIT_PULLBACK',
    'WATCH_ONLY',
    'AVOID',
    'UNKNOWN',
  ],
  time: [
    'INTRADAY_OPEN',
    'INTRADAY_MORNING',
    'INTRADAY_AFTERNOON',
    'INTRADAY_CLOSE',
    'INTRADAY_MANUAL',
    'CLOSE_NEXT_SESSION',
  ],
  liquidity: ['HIGH', 'GOOD', 'LIMITED', 'THIN', 'UNKNOWN'],
})

const NUMERIC_FEATURES = Object.freeze([
  'cheapScore',
  'formulaScore',
  'quotePct',
  'logAmount',
  'turnover',
  'volumeRatio',
  'mainRatio',
  'riskReward',
  'entryDistancePct',
  'stopDistancePct',
  'targetDistancePct',
  'marketAllowed',
  'displayed',
])

export const OPPORTUNITY_SCORE_FEATURE_NAMES = Object.freeze([
  ...NUMERIC_FEATURES,
  ...Object.entries(CATEGORIES).flatMap(([prefix, values]) =>
    values.map((value) => `${prefix}_${value}`),
  ),
])

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rounded(value, digits = 3) {
  const number = finite(value)
  return number == null ? 0 : +number.toFixed(digits)
}

function category(value, values) {
  const normalized = String(value || '').toUpperCase()
  return values.includes(normalized) ? normalized : 'UNKNOWN'
}

function timeBucket(mode, slot) {
  if (mode === 'CLOSE') return 'CLOSE_NEXT_SESSION'
  const minutes = Number(slot)
  if (!Number.isFinite(minutes)) return 'INTRADAY_MANUAL'
  if (minutes <= 630) return 'INTRADAY_OPEN'
  if (minutes <= 690) return 'INTRADAY_MORNING'
  if (minutes <= 840) return 'INTRADAY_AFTERNOON'
  return 'INTRADAY_CLOSE'
}

function liquidityBucket(amount) {
  const value = finite(amount)
  if (value == null || value < 0) return 'UNKNOWN'
  if (value >= 500_000_000) return 'HIGH'
  if (value >= 100_000_000) return 'GOOD'
  if (value >= 50_000_000) return 'LIMITED'
  return 'THIN'
}

function oneHot(target, prefix, values, selected) {
  for (const value of values) {
    target[`${prefix}_${value}`] = value === selected ? 1 : 0
  }
}

function distancePct(value, anchor) {
  const number = finite(value)
  const base = finite(anchor)
  return number != null && base > 0
    ? rounded((number / base - 1) * 100)
    : 0
}

function riskDistancePct(upper, lower) {
  const high = finite(upper)
  const low = finite(lower)
  return high > 0 && low != null
    ? rounded((high - low) / high * 100)
    : 0
}

export function buildOpportunityScoreInput({
  event,
  batch = {},
} = {}) {
  const code = String(event?.code || '')
  if (!/^\d{6}$/.test(code)) {
    throw new Error('机会评分股票代码无效')
  }
  if (event?.decision?.priceContractValid !== true) {
    throw new Error('机会评分只接受完整价格合同')
  }
  const formulaId = String(event.decision.formulaId || 'UNKNOWN')
  const formulaEvaluation = (
    Array.isArray(event.formulaEvaluations)
      ? event.formulaEvaluations
      : []
  ).find((item) => item?.formulaId === formulaId)
  const quote = event.quote || {}
  const decision = event.decision || {}
  const marketGate = batch.marketGate
  const mode = category(
    batch.mode || event.mode,
    CATEGORIES.mode,
  )
  const selected = {
    formula: category(formulaId, CATEGORIES.formula),
    mode,
    priceType: category(
      decision.priceType,
      CATEGORIES.priceType,
    ),
    market: category(
      marketGate?.riskTier
      || (
        marketGate
          ? marketGate.allowed === true ? 'STANDARD' : 'BLOCKED'
          : 'UNKNOWN'
      ),
      CATEGORIES.market,
    ),
    sector: category(event.sector?.phase, CATEGORIES.sector),
    sectorAction: category(
      event.sector?.actionability,
      CATEGORIES.sectorAction,
    ),
    time: timeBucket(mode, batch.slot),
    liquidity: liquidityBucket(quote.amount),
  }
  const factors = {
    cheapScore: rounded(event.cheapScore),
    formulaScore: rounded(formulaEvaluation?.score),
    quotePct: rounded(quote.pct),
    logAmount: rounded(
      finite(quote.amount) >= 0 ? Math.log1p(Number(quote.amount)) : 0,
      6,
    ),
    turnover: rounded(quote.turnover),
    volumeRatio: rounded(quote.volumeRatio),
    mainRatio: rounded(quote.mainRatio),
    riskReward: rounded(decision.riskReward),
    entryDistancePct: distancePct(
      decision.primaryPrice,
      quote.price,
    ),
    stopDistancePct: riskDistancePct(
      decision.primaryPrice,
      decision.stopPrice,
    ),
    targetDistancePct: distancePct(
      decision.targetPrice,
      decision.primaryPrice,
    ),
    marketAllowed: marketGate?.allowed === true ? 1 : 0,
    displayed: event.stageReached === 'DISPLAYED' ? 1 : 0,
  }
  for (const [prefix, values] of Object.entries(CATEGORIES)) {
    oneHot(factors, prefix, values, selected[prefix])
  }
  return {
    schemaVersion: OPPORTUNITY_SCORE_FEATURE_SCHEMA_VERSION,
    asOf: finite(event.asOf),
    code,
    formulaId,
    factors: Object.fromEntries(
      OPPORTUNITY_SCORE_FEATURE_NAMES.map(
        (name) => [name, rounded(factors[name], 6)],
      ),
    ),
    dimensions: {
      mode: selected.mode,
      priceType: selected.priceType,
      marketState: selected.market,
      sectorPhase: selected.sector,
      sectorActionability: selected.sectorAction,
      timeBucket: selected.time,
      liquidityBucket: selected.liquidity,
      displayed: event.stageReached === 'DISPLAYED',
    },
  }
}

export function unavailableOpportunityScore(input = {}, reason) {
  return {
    schemaVersion: OPPORTUNITY_SCORE_SCHEMA_VERSION,
    state: 'NOT_READY',
    reason: String(reason || 'MODEL_NOT_READY').slice(0, 80),
    modelVersion: null,
    asOf: finite(input.asOf),
    code: String(input.code || ''),
    formulaId: String(input.formulaId || ''),
    pFill: null,
    pWinGivenFill: null,
    expectedNetR: null,
    netRLowerBound: null,
    expectedShortfall10: null,
    calibration: null,
    outOfDistribution: false,
  }
}

function probability(value) {
  const number = finite(value)
  if (number == null || number < 0 || number > 1) {
    throw new Error('机会评分概率无效')
  }
  return rounded(number, 6)
}

function requiredMetric(value) {
  const number = finite(value)
  if (number == null) throw new Error('机会评分数值无效')
  return rounded(number, 6)
}

export function normalizeOpportunityScoreResponse(
  response,
  expected = {},
) {
  if (
    !response
    || response.schemaVersion !== OPPORTUNITY_SCORE_SCHEMA_VERSION
  ) throw new Error('机会评分响应版本无效')
  if (String(response.code || '') !== String(expected.code || '')) {
    throw new Error('机会评分股票不匹配')
  }
  if (
    String(response.formulaId || '')
    !== String(expected.formulaId || '')
  ) throw new Error('机会评分公式不匹配')
  const state = String(response.state || '')
  if (!['READY', 'NOT_READY', 'OUT_OF_DISTRIBUTION'].includes(state)) {
    throw new Error('机会评分状态无效')
  }
  if (state !== 'READY' || response.outOfDistribution === true) {
    return {
      ...unavailableOpportunityScore(
        expected,
        response.reason || state,
      ),
      state,
      modelVersion: String(response.modelVersion || '') || null,
      outOfDistribution:
        state === 'OUT_OF_DISTRIBUTION'
        || response.outOfDistribution === true,
    }
  }
  const sampleCount = Math.max(
    0,
    Math.trunc(finite(response.calibration?.sampleCount) || 0),
  )
  return {
    schemaVersion: OPPORTUNITY_SCORE_SCHEMA_VERSION,
    state,
    reason: null,
    modelVersion: String(response.modelVersion || ''),
    asOf: finite(response.asOf) ?? finite(expected.asOf),
    code: String(response.code),
    formulaId: String(response.formulaId),
    pFill: probability(response.pFill),
    pWinGivenFill: probability(response.pWinGivenFill),
    expectedNetR: requiredMetric(response.expectedNetR),
    netRLowerBound: requiredMetric(response.netRLowerBound),
    expectedShortfall10: requiredMetric(
      response.expectedShortfall10,
    ),
    calibration: {
      method: String(response.calibration?.method || 'none'),
      sampleCount,
      bucket: String(response.calibration?.bucket || ''),
    },
    outOfDistribution: false,
  }
}
