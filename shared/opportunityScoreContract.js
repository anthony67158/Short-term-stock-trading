import {
  OPPORTUNITY_SHADOW_FEATURE_NAMES,
} from './opportunityShadowFeatures.js'

export const OPPORTUNITY_SCORE_FEATURE_SCHEMA_VERSION =
  'opportunity-score-feature.v6'
export const OPPORTUNITY_SCORE_SCHEMA_VERSION =
  'opportunity-score.v1'
export const OPPORTUNITY_SCORE_INPUT_CONTEXT_VERSION =
  'opportunity-score-input-context.v3'

const CATEGORIES = Object.freeze({
  formula: [
    'TAIL_REVERSAL',
    'INTRADAY_VWAP_PULLBACK',
    'INTRADAY_ACCUMULATION',
    'CLOSE_TREND_PULLBACK',
    'CLOSE_SQUEEZE',
    'UNKNOWN',
  ],
  playbook: [
    'MOMENTUM_BREAKOUT',
    'LEADER_PULLBACK',
    'ACCUMULATION',
    'CATALYST',
    'PANIC_REVERSAL',
    'RANGE_REVERSION',
    'UNKNOWN',
  ],
  route: [
    'IMMEDIATE',
    'PULLBACK',
    'BREAKOUT',
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
  recall: [
    'MOMENTUM',
    'ACCUMULATION',
    'REVERSAL',
    'LIQUIDITY',
    'EXPLORATION',
    'UNKNOWN',
  ],
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
  'playbookScore',
  'marketOpportunityFactor',
  'cheapScorePct',
  'recallMomentumPct',
  'recallAccumulationPct',
  'recallReversalPct',
  'recallLiquidityPct',
  'recallSourceCount',
  'explorationSample',
  ...OPPORTUNITY_SHADOW_FEATURE_NAMES,
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
  const asOf = finite(event.asOf)
  if (!(asOf > 0)) throw new Error('机会评分时点无效')
  const formulaId = String(event.decision.formulaId || 'UNKNOWN')
  const formulaEvaluation = (
    Array.isArray(event.formulaEvaluations)
      ? event.formulaEvaluations
      : []
  ).find((item) => item?.formulaId === formulaId)
  const bestFormulaScore = (Array.isArray(event.formulaEvaluations)
    ? event.formulaEvaluations
    : [])
    .map((item) => finite(item?.score))
    .filter((value) => value != null)
    .sort((left, right) => right - left)[0]
  const quote = event.quote || {}
  const decision = event.decision || {}
  const marketGate = batch.marketGate
  const shadow = event.shadowFeatures || {}
  const recallSource = String(
    event.recall?.primarySource || '',
  ).trim().toUpperCase()
  const hasRecallContext = !!recallSource && recallSource !== 'UNKNOWN'
  const mode = category(
    batch.mode || event.mode,
    CATEGORIES.mode,
  )
  const selected = {
    formula: category(formulaId, CATEGORIES.formula),
    playbook: category(
      decision.playbookId || event.playbookId,
      CATEGORIES.playbook,
    ),
    route: category(
      decision.route,
      CATEGORIES.route,
    ),
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
    recall: category(
      hasRecallContext
        ? recallSource
        : 'EXPLORATION',
      CATEGORIES.recall,
    ),
  }
  const factors = {
    cheapScore: rounded(event.cheapScore),
    formulaScore: rounded(
      formulaEvaluation?.score ?? bestFormulaScore,
    ),
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
    playbookScore: rounded(decision.playbookScore),
    marketOpportunityFactor:
      rounded(decision.marketOpportunityFactor),
    cheapScorePct: rounded(event.recall?.cheapScorePct),
    recallMomentumPct: rounded(event.recall?.momentumPct),
    recallAccumulationPct: rounded(event.recall?.accumulationPct),
    recallReversalPct: rounded(event.recall?.reversalPct),
    recallLiquidityPct: rounded(event.recall?.liquidityPct),
    recallSourceCount: Math.max(
      hasRecallContext ? 0 : 1,
      (Array.isArray(event.recall?.sources)
        ? event.recall.sources
        : []).length,
    ),
    explorationSample:
      event.recall?.exploration === true || !hasRecallContext ? 1 : 0,
    ret2dPct: rounded(shadow.ret2dPct),
    ret5dPct: rounded(shadow.ret5dPct),
    openGapPct: rounded(shadow.openGapPct),
    intradayRangePct: rounded(shadow.intradayRangePct),
    distanceToHighPct: rounded(shadow.distanceToHighPct),
    vwapDistancePct: rounded(shadow.vwapDistancePct),
    atrPct: rounded(shadow.atrPct),
    mainNetYi: rounded(shadow.mainNetYi),
    retailNetYi: rounded(shadow.retailNetYi),
    fundCurrentAvailable: rounded(shadow.fundCurrentAvailable),
    fundHistoryAvailable: rounded(shadow.fundHistoryAvailable),
    fundHistoryDayCount: rounded(shadow.fundHistoryDayCount),
    fundHistoryComplete: rounded(shadow.fundHistoryComplete),
    main5dYi: rounded(shadow.main5dYi),
    retail5dYi: rounded(shadow.retail5dYi),
    mainInflowDays5: rounded(shadow.mainInflowDays5),
    retailInflowDays5: rounded(shadow.retailInflowDays5),
    mainStreak5: rounded(shadow.mainStreak5),
    retailStreak5: rounded(shadow.retailStreak5),
    mainTrendSlope5: rounded(shadow.mainTrendSlope5),
    retailTrendSlope5: rounded(shadow.retailTrendSlope5),
    flowDivergenceBalance5:
      rounded(shadow.flowDivergenceBalance5),
    flowDivergence: rounded(shadow.flowDivergence),
    sectorRelativeStrength: rounded(shadow.sectorRelativeStrength),
    sectorRankPct: rounded(shadow.sectorRankPct),
    sectorMainNetYi: rounded(shadow.sectorMainNetYi),
    sectorBreadthPct: rounded(shadow.sectorBreadthPct),
    sectorMemberCount: rounded(shadow.sectorMemberCount),
    sectorFlowRankPct: rounded(shadow.sectorFlowRankPct),
    limitUpDistancePct: rounded(shadow.limitUpDistancePct),
    limitHitCount5d: rounded(shadow.limitHitCount5d),
    failedLimitCount5d: rounded(shadow.failedLimitCount5d),
    orderImbalanceShort: rounded(shadow.orderImbalanceShort),
    overheatReversalRisk: rounded(shadow.overheatReversalRisk),
    liquidityComposite: rounded(shadow.liquidityComposite),
    evidenceCompleteness: rounded(shadow.evidenceCompleteness),
    signalOrderFlowContinuation:
      rounded(shadow.signalOrderFlowContinuation),
    signalOverheatRisk: rounded(shadow.signalOverheatRisk),
    signalLiquidityConfirmed: rounded(shadow.signalLiquidityConfirmed),
    signalSectorRelativeStrength:
      rounded(shadow.signalSectorRelativeStrength),
    signalLimitCrowding: rounded(shadow.signalLimitCrowding),
    dailyTechnicalAvailable:
      rounded(shadow.dailyTechnicalAvailable),
    intradayTechnicalAvailable:
      rounded(shadow.intradayTechnicalAvailable),
    sectorContextAvailable:
      rounded(shadow.sectorContextAvailable),
    ...Object.fromEntries(
      OPPORTUNITY_SHADOW_FEATURE_NAMES.map((name) => [
        name,
        rounded(shadow[name]),
      ]),
    ),
  }
  for (const [prefix, values] of Object.entries(CATEGORIES)) {
    oneHot(factors, prefix, values, selected[prefix])
  }
  return {
    schemaVersion: OPPORTUNITY_SCORE_FEATURE_SCHEMA_VERSION,
    inputContextVersion: OPPORTUNITY_SCORE_INPUT_CONTEXT_VERSION,
    asOf,
    code,
    formulaId,
    factors: Object.fromEntries(
      OPPORTUNITY_SCORE_FEATURE_NAMES.map(
        (name) => [name, rounded(factors[name], 6)],
      ),
    ),
    dimensions: {
      mode: selected.mode,
      playbook: selected.playbook,
      route: selected.route,
      priceType: selected.priceType,
      marketState: selected.market,
      sectorPhase: selected.sector,
      sectorActionability: selected.sectorAction,
      timeBucket: selected.time,
      liquidityBucket: selected.liquidity,
      recallSource: selected.recall,
      displayed: event.stageReached === 'DISPLAYED',
    },
  }
}

export function isOpportunityScoreInput(value) {
  if (
    !value
    || value.schemaVersion !== OPPORTUNITY_SCORE_FEATURE_SCHEMA_VERSION
    || !/^\d{6}$/.test(String(value.code || ''))
    || !String(value.formulaId || '')
    || !value.factors
    || typeof value.factors !== 'object'
    || !Number.isFinite(Number(value.asOf))
  ) return false
  const names = Object.keys(value.factors)
  return (
    names.length === OPPORTUNITY_SCORE_FEATURE_NAMES.length
    && names.every(
      (name, index) =>
        name === OPPORTUNITY_SCORE_FEATURE_NAMES[index]
        && Number.isFinite(Number(value.factors[name])),
    )
  )
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
    rankingScore: null,
    meanConfidenceLowerBound: null,
    lowerBoundKind: 'PREDICTION_P10',
    shadowOnly: true,
    baselineSelected: false,
    productionEligible: false,
    expectedShortfall10: null,
    calibration: null,
    taskValues: null,
    engine: null,
    outOfDistribution: false,
    inputContextVersion:
      input.inputContextVersion
      || OPPORTUNITY_SCORE_INPUT_CONTEXT_VERSION,
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

function optionalMetric(value) {
  const number = finite(value)
  return number == null ? null : rounded(number, 6)
}

function normalizeTaskValues(value) {
  if (value == null) return null
  if (
    typeof value !== 'object'
    || value.schemaVersion !== 'decision-task-values.v1'
  ) {
    throw new Error('决策任务头响应无效')
  }
  const portfolio = value.portfolio || {}
  const source = String(portfolio.source || '')
  return {
    schemaVersion: 'decision-task-values.v1',
    selection: {
      rankingScore: optionalMetric(value.selection?.rankingScore),
      expectedOpportunityR:
        requiredMetric(value.selection?.expectedOpportunityR),
    },
    entry: {
      expectedNetR: requiredMetric(value.entry?.expectedNetR),
      pFill: probability(value.entry?.pFill),
    },
    portfolio: {
      schemaVersion: String(portfolio.schemaVersion || ''),
      addRelativeToHoldR:
        requiredMetric(portfolio.addRelativeToHoldR),
      holdR: requiredMetric(portfolio.holdR),
      reduceRelativeToHoldR:
        requiredMetric(portfolio.reduceRelativeToHoldR),
      exitRelativeToHoldR:
        requiredMetric(portfolio.exitRelativeToHoldR),
      addExecutionAdjustedR:
        requiredMetric(portfolio.addExecutionAdjustedR),
      source,
    },
    execution: {
      pFill: probability(value.execution?.pFill),
    },
    risk: {
      q10R: requiredMetric(value.risk?.q10R),
      cvarR: requiredMetric(value.risk?.cvarR),
    },
    review: {
      recompute: value.review?.recompute !== false,
      source: String(value.review?.source || ''),
    },
  }
}

function normalizeEngine(value) {
  if (value == null) return null
  if (typeof value !== 'object') {
    throw new Error('决策引擎版本无效')
  }
  const heads = value.heads
  if (!heads || typeof heads !== 'object') {
    throw new Error('决策任务头版本无效')
  }
  return {
    stateEncoder: String(value.stateEncoder || ''),
    router: String(value.router || ''),
    heads: Object.fromEntries(
      Object.entries(heads)
        .map(([name, version]) => [
          String(name),
          String(version || ''),
        ])
        .filter(([, version]) => version),
    ),
  }
}

export function isExecutableOpportunityScore(value) {
  return value?.state === 'READY'
    && (value.usagePolicy === 'DIRECT' || (
      value.outOfDistribution !== true
      && value.shadowOnly === false
      && value.productionEligible === true
    ))
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
  if (state !== 'READY' || (response.outOfDistribution === true && response.usagePolicy !== 'DIRECT')) {
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
  const modelVersion = String(response.modelVersion || '')
  if (!modelVersion) throw new Error('机会评分模型版本无效')
  const sampleCount = Math.max(
    0,
    Math.trunc(finite(response.calibration?.sampleCount) || 0),
  )
  return {
    schemaVersion: OPPORTUNITY_SCORE_SCHEMA_VERSION,
    state,
    reason: null,
    modelVersion,
    asOf: finite(response.asOf) ?? finite(expected.asOf),
    code: String(response.code),
    formulaId: String(response.formulaId),
    pFill: probability(response.pFill),
    pWinGivenFill: probability(response.pWinGivenFill),
    expectedNetR: requiredMetric(response.expectedNetR),
    netRLowerBound: requiredMetric(response.netRLowerBound),
    rankingScore: response.rankingScore == null
      ? null
      : probability(response.rankingScore),
    meanConfidenceLowerBound: finite(response.meanConfidenceLowerBound),
    lowerBoundKind: 'PREDICTION_P10',
    shadowOnly: response.shadowOnly !== false,
    baselineSelected: response.baselineSelected === true,
    productionEligible:
      response.productionEligible === true && response.shadowOnly === false,
    usagePolicy: response.usagePolicy === 'DIRECT' ? 'DIRECT' : 'QUALIFIED',
    expectedShortfall10: requiredMetric(
      response.expectedShortfall10,
    ),
    calibration: {
      method: String(response.calibration?.method || 'none'),
      sampleCount,
      bucket: String(response.calibration?.bucket || ''),
      pWinLevel: String(response.calibration?.pWinLevel || ''),
      pWinBucket: String(response.calibration?.pWinBucket || ''),
      pWinSampleCount: Math.max(
        0,
        Math.trunc(
          finite(response.calibration?.pWinSampleCount) || 0,
        ),
      ),
    },
    taskValues: normalizeTaskValues(response.taskValues),
    engine: normalizeEngine(response.engine),
    outOfDistribution: response.outOfDistribution === true,
    inputContextVersion:
      expected.inputContextVersion
      || OPPORTUNITY_SCORE_INPUT_CONTEXT_VERSION,
  }
}
