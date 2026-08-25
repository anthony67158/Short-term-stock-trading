import { getStrategyCatalogV2 } from './strategyCatalogV2.js'
import {
  buildDefaultStrategyGovernance,
  strategyCanInfluenceProduction,
} from './strategyGovernanceV2.js'
import { evaluateStrategySignalV2 } from './strategySpecV2.js'

const RISK_REDUCING_ACTIONS = new Set(['REDUCE', 'EXIT', 'T_SELL_FIRST'])
const RISK_INCREASING_ACTIONS = new Set(['BUY', 'ADD', 'T_BUY_FIRST'])
const POSITION_ACTIONS = new Set(['T_BUY_FIRST', 'T_SELL_FIRST'])
const PURPOSE_PRIORITY = Object.freeze({
  EXIT: 500,
  POSITION_MANAGEMENT: 400,
  ENTRY: 300,
  RANKING: 200,
})
const STATE_PRIORITY = Object.freeze({
  active: 90,
  approved: 80,
  'paper-qualified': 70,
  shadow: 60,
  backtested: 50,
  rejected: 20,
  draft: 10,
  suspended: 0,
  retired: -10,
})
const MINIMUM_SHADOW_SAMPLES = 30
const REGIME_FAMILY_PRIORITY = Object.freeze({
  TREND_STRONG: {
    TREND_BREAKOUT: 50,
    CROSS_SECTIONAL_MOMENTUM: 40,
    MULTI_FACTOR_RANKING: 30,
  },
  TRANSITION: {
    CROSS_SECTIONAL_MOMENTUM: 50,
    MULTI_FACTOR_RANKING: 40,
  },
  RANGE: {
    RANGE_MEAN_REVERSION: 50,
    MULTI_FACTOR_RANKING: 30,
  },
  RISK_OFF: {
    DEFENSIVE_EXIT: 100,
  },
  UNKNOWN: {
    DEFENSIVE_EXIT: 100,
  },
})

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function boolean(value) {
  return value === true
}

export function buildStrategyRoutingContext(
  payload = {},
  market = {},
) {
  const quote = payload.todayQuote || {}
  const tech = payload.tech || {}
  const quant = payload.quant || {}
  const sector = payload.sector || payload.sectorContext || {}
  const quotePrice = finite(quote.price)
  const resistance = finite(tech.resistance ?? tech.sr?.resistance)
  const support = finite(tech.support ?? tech.sr?.support)
  const vwap = finite(payload.intraday?.vwap)
  const bollPosition = finite(tech.bollPct ?? tech.boll?.pctB)
  const trend = String(tech.maTrend || '')
  const maSlope20 = finite(tech.maSlope20 ?? tech.ma20Slope)
    ?? (/多头|bull/i.test(trend) ? 1 : /空头|bear/i.test(trend) ? -1 : 0)
  return {
    account: {
      hasBasePosition: (
        (finite(payload.holdQty) || 0) > 0
        || (finite(payload.holding?.qty) || 0) > 0
      ),
    },
    amount: finite(quote.amount),
    fund: {
      mainRatio: finite(payload.stockFund?.mainRatio),
    },
    liquidity: {
      adv20: finite(
        quote.adv20
        ?? payload.liquidity?.adv20
        ?? payload.tech?.adv20,
      ),
    },
    mainRatio: finite(payload.stockFund?.mainRatio),
    market: {
      regime: String(market.regime || 'UNKNOWN'),
    },
    marketEnv: {
      score: finite(market.score),
    },
    marketRegime: String(market.regime || 'UNKNOWN'),
    marketScore: finite(market.score),
    pct: finite(quote.pct),
    quant: {
      expRet: finite(quant.forecast?.expRet ?? quant.expRet),
      highConfFired: boolean(quant.highConfSignal?.fired),
      score: finite(quant.score),
      upProb: finite(quant.forecast?.upProb ?? quant.upProb),
    },
    relativeStrength20: finite(
      tech.relativeStrength20
      ?? payload.relativeStrength20,
    ),
    sector: {
      breadth: finite(
        sector.breadth
        ?? payload.sectorBreadth,
      ),
    },
    speed: finite(quote.speed),
    technical: {
      atrPct: finite(tech.atrPct ?? tech.atr),
      atrStopBroken: boolean(
        tech.atrStopBroken ?? payload.atrStopBroken,
      ),
      bollPct: bollPosition == null
        ? null
        : bollPosition > 1 ? +(bollPosition / 100).toFixed(4) : bollPosition,
      donchianBreakout: tech.donchianBreakout != null
        ? boolean(tech.donchianBreakout)
        : quotePrice != null
          && resistance != null
          && quotePrice >= resistance,
      maSlope20,
      rsi6: finite(tech.rsi6 ?? tech.rsi),
      structureBreak: tech.structureBreak != null
        ? boolean(tech.structureBreak)
        : quotePrice != null
          && support != null
          && quotePrice < support,
      vwapDeviationPct: finite(
        tech.vwapDeviationPct ?? tech.vwapDeviation,
      ) ?? (
        quotePrice != null && vwap > 0
          ? +((quotePrice / vwap - 1) * 100).toFixed(2)
          : null
      ),
    },
    turnover: finite(quote.turnover),
    volRatio: finite(quote.volRatio),
  }
}

function shadowScore(record) {
  const shadow = record?.shadow || {}
  if (Number(shadow.samples) < MINIMUM_SHADOW_SAMPLES) {
    return {
      eligible: false,
      score: 0,
    }
  }
  const netReturn = finite(shadow.netReturn) || 0
  const drawdown = Math.abs(Math.min(0, finite(shadow.maximumDrawdown) || 0))
  const profitFactor = finite(shadow.profitFactor) || 0
  return {
    eligible: true,
    score: Math.max(
      -20,
      Math.min(20, netReturn * 100 - drawdown * 50 + (profitFactor - 1) * 5),
    ),
  }
}

function purposePriority(purpose, requestedAction) {
  if (RISK_REDUCING_ACTIONS.has(requestedAction)) {
    return purpose === 'EXIT' ? 1000 : PURPOSE_PRIORITY[purpose] || 0
  }
  if (POSITION_ACTIONS.has(requestedAction)) {
    return purpose === 'POSITION_MANAGEMENT'
      ? 900
      : PURPOSE_PRIORITY[purpose] || 0
  }
  if (purpose === 'EXIT') return -100
  return PURPOSE_PRIORITY[purpose] || 0
}

function candidateRecord(strategy, governance, context, requestedAction) {
  const record = governance.strategies.find(
    (item) => item.strategyId === strategy.strategyId,
  )
  const signal = evaluateStrategySignalV2(strategy, context)
  const shadow = shadowScore(record)
  const productionEligible = (
    signal.passed
    && strategyCanInfluenceProduction(record)
    && (
      strategy.riskLimits.allowRiskIncrease
      || RISK_REDUCING_ACTIONS.has(requestedAction)
    )
  )
  return {
    strategyId: strategy.strategyId,
    specVersion: strategy.specVersion,
    name: strategy.name,
    family: strategy.family,
    purpose: strategy.purpose,
    state: record?.state || 'draft',
    eligibleRegimes: strategy.eligibleRegimes,
    regimeEligible: signal.regimeEligible,
    signalPassed: signal.passed,
    signalReason: signal.reason,
    matchedRules: signal.matchedRules,
    failedRules: signal.failedRules,
    productionEligible,
    actionability: productionEligible ? 'READY' : 'SHADOW_ONLY',
    shadowPerformanceEligible: shadow.eligible,
    shadowScore: shadow.score,
    outOfSample: record?.evaluation || null,
    blockers: record?.blockers || [],
    _priority: purposePriority(strategy.purpose, requestedAction),
    _regimePriority:
      REGIME_FAMILY_PRIORITY[context.marketRegime]?.[strategy.family] || 0,
    _statePriority: STATE_PRIORITY[record?.state] ?? 0,
  }
}

function publicCandidate(candidate) {
  const {
    _priority,
    _regimePriority,
    _statePriority,
    ...output
  } = candidate
  return output
}

export function routeStrategyPortfolio({
  marketRegime = 'UNKNOWN',
  context = {},
  governance = null,
  requestedAction = 'WATCH',
} = {}) {
  const catalog = getStrategyCatalogV2()
  const normalizedGovernance = governance?.schemaVersion
    === 'strategy-governance.v2'
    ? governance
    : buildDefaultStrategyGovernance(governance)
  const routingContext = {
    ...context,
    marketRegime,
    market: {
      ...(context.market || {}),
      regime: marketRegime,
    },
  }
  const candidates = catalog.strategies.map((strategy) =>
    candidateRecord(
      strategy,
      normalizedGovernance,
      routingContext,
      requestedAction,
    )
  ).sort((left, right) =>
    Number(right.signalPassed) - Number(left.signalPassed)
    || right._priority - left._priority
    || right._regimePriority - left._regimePriority
    || right._statePriority - left._statePriority
    || right.shadowScore - left.shadowScore
    || left.strategyId.localeCompare(right.strategyId)
  )
  const viable = candidates.filter(
    (item) =>
      item.signalPassed
      && !['suspended', 'retired'].includes(item.state)
      && (
        !RISK_INCREASING_ACTIONS.has(requestedAction)
        || item.purpose !== 'EXIT'
      )
      && (
        !RISK_REDUCING_ACTIONS.has(requestedAction)
        || item.purpose === 'EXIT'
      ),
  )
  const production = viable.find((item) => item.productionEligible) || null
  const research = viable[0] || null
  return {
    schemaVersion: 'strategy-route.v1',
    catalogVersion: catalog.catalogVersion,
    marketRegime,
    requestedAction,
    policyPriority: [
      'HARD_EXIT',
      'RISK_REDUCTION',
      'POSITION_MANAGEMENT',
      'NEW_ENTRY',
      'T_OPTIMIZATION',
    ],
    production: production ? publicCandidate(production) : null,
    research: research ? publicCandidate(research) : null,
    candidates: candidates.map(publicCandidate),
  }
}
