import { buildActionEligibility } from './actionEligibility.js'

export const DECISION_STATE_SCHEMA_VERSION = 'decision-state.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function text(value, maximum = 80) {
  return String(value || '').trim().slice(0, maximum)
}

function compactPath(plan = {}) {
  return {
    route: text(plan.route || 'UNKNOWN', 24).toUpperCase(),
    entryPrice: finite(plan.entryPlan?.price),
    stopPrice: finite(plan.exitPlan?.hardStopPrice),
    targetPrice: finite(plan.exitPlan?.takeProfitPrice),
    riskReward: finite(plan.riskReward),
  }
}

export function buildDecisionState({
  code,
  name,
  asOf = Date.now(),
  quote = {},
  position = {},
  account = {},
  market = {},
  sector = {},
  fund = {},
  evidence = {},
  paths = [],
  review = null,
  model = {},
} = {}) {
  const normalizedCode = text(code, 6)
  if (!/^\d{6}$/.test(normalizedCode)) {
    throw new Error('决策状态股票代码无效')
  }
  const timestamp = finite(asOf)
  if (!(timestamp > 0)) throw new Error('决策状态时点无效')
  const normalizedPaths = (Array.isArray(paths) ? paths : [])
    .map(compactPath)
    .filter((path) => (
      ['IMMEDIATE', 'PULLBACK', 'BREAKOUT'].includes(path.route)
      && path.entryPrice > 0
      && path.stopPrice > 0
      && path.targetPrice > path.entryPrice
      && path.stopPrice < path.entryPrice
    ))
  const eligibility = buildActionEligibility({
    position,
    quote,
    account,
    evidence,
    model,
  })
  return {
    schemaVersion: DECISION_STATE_SCHEMA_VERSION,
    asOf: timestamp,
    code: normalizedCode,
    name: text(name, 40),
    quote: {
      price: finite(quote.price),
      pct: finite(quote.pct),
      live: quote.live === true,
      volumeRatio: finite(quote.volumeRatio ?? quote.volRatio),
      turnover: finite(quote.turnover),
    },
    position: {
      totalLots: eligibility.totalLots,
      sellableLots: eligibility.sellableLots,
      costPrice: finite(position.costPrice ?? position.holdCost),
      hardStopPrice:
        finite(position.hardStopPrice ?? position.holdingStopPrice),
      stockWeightPct: finite(position.stockWeightPct),
      profitPct: finite(position.profitPct),
    },
    account: {
      cash: finite(account.cash),
      totalAssets: finite(account.totalAssets),
      positionPct: finite(account.positionPct ?? account.position),
      maxStockWeightPct:
        finite(account.maxStockWeightPct ?? account.maxStockWeight),
      circuitOpen: account.circuitOpen === true,
      riskIncreaseAllowed: account.riskIncreaseAllowed !== false,
      complete: account.complete !== false,
    },
    market,
    sector,
    fund,
    evidence: {
      complete: evidence.complete !== false,
      missing: Array.isArray(evidence.missing)
        ? evidence.missing.map((item) => text(item, 120)).filter(Boolean)
        : [],
    },
    paths: normalizedPaths,
    review,
    model: {
      ready: model.ready !== false,
      version: text(model.version, 120) || null,
    },
    eligibility,
  }
}

export function isDecisionState(value) {
  return (
    value?.schemaVersion === DECISION_STATE_SCHEMA_VERSION
    && /^\d{6}$/.test(String(value.code || ''))
    && finite(value.asOf) > 0
    && Array.isArray(value.paths)
    && value.eligibility?.actions?.length > 0
  )
}
