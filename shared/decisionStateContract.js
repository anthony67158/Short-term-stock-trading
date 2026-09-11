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

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  )
}

function stateFingerprint(value) {
  const source = JSON.stringify(stable(value))
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `state.${(first >>> 0).toString(16).padStart(8, '0')}${
    (second >>> 0).toString(16).padStart(8, '0')
  }`
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
  const state = {
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
  return {
    ...state,
    stateFingerprint: stateFingerprint(state),
  }
}

export function isDecisionState(value) {
  return (
    value?.schemaVersion === DECISION_STATE_SCHEMA_VERSION
    && /^\d{6}$/.test(String(value.code || ''))
    && finite(value.asOf) > 0
    && /^state\.[0-9a-f]{16}$/.test(
      String(value.stateFingerprint || ''),
    )
    && Array.isArray(value.paths)
    && value.eligibility?.actions?.length > 0
  )
}
