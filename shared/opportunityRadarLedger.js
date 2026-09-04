import {
  resolveAshareTradingRule,
} from './priceLimitPolicy.js'
import {
  OPPORTUNITY_SHADOW_FEATURE_NAMES,
} from './opportunityShadowFeatures.js'

export const OPPORTUNITY_RADAR_LEDGER_SCHEMA_VERSION =
  'opportunity-radar-ledger.v1'

const MODES = new Set(['intraday', 'close'])
const STAGES = new Set([
  'PREFILTER',
  'TECHNICAL',
  'EVIDENCE',
  'DISPLAYED',
])

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function text(value, maximum = 120) {
  return String(value || '').trim().slice(0, maximum)
}

function uniqueText(values, maximum = 12) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => text(value, 160))
      .filter(Boolean),
  )].slice(0, maximum)
}

function safeMode(value) {
  const mode = String(value || '').toLowerCase()
  if (!MODES.has(mode)) throw new Error('机会雷达账本模式无效')
  return mode
}

function safeDate(value) {
  const date = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('机会雷达账本日期无效')
  }
  return date
}

function safeSlot(value) {
  const slot = String(value || 'manual')
  if (!/^(?:\d{4}|manual)$/.test(slot)) {
    throw new Error('机会雷达账本时段无效')
  }
  return slot
}

function quoteProjection(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    price: finite(source.price),
    preClose: finite(source.preClose ?? source.prevClose),
    open: finite(source.open),
    high: finite(source.high),
    low: finite(source.low),
    pct: finite(source.pct),
    amount: finite(source.amount),
    turnover: finite(source.turnover),
    volumeRatio: finite(source.volumeRatio),
    mainRatio: finite(source.mainRatio),
    limitUpPrice: finite(source.limitUpPrice),
    limitDownPrice: finite(source.limitDownPrice),
    tradeDate: text(source.tradeDate, 10) || null,
  }
}

function formulaProjection(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    formulaId: text(source.formulaId, 60),
    matched: source.matched === true,
    score: finite(source.score),
    priceType: text(source.priceType, 40) || null,
    blockers: uniqueText(source.blockers),
  }
}

function decisionProjection(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    action: text(source.action, 40),
    formulaId: text(source.formulaId, 60) || null,
    primaryPrice: finite(source.primaryPrice),
    priceType: text(source.priceType, 40) || null,
    stopPrice: finite(source.stopPrice),
    targetPrice: finite(source.targetPrice),
    riskReward: finite(source.riskReward),
    validUntil: finite(source.validUntil),
    timeStopTradingDays: Math.max(
      1,
      Math.trunc(finite(source.timeStopTradingDays) || 5),
    ),
    priceContractValid: source.priceContractValid === true,
    marketAllowsRisk: source.marketAllowsRisk === true,
    executionState: text(source.executionState, 40) || null,
  }
}

function sectorProjection(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    code: text(source.code, 20),
    name: text(source.name, 60),
    phase: text(source.phase, 40) || null,
    actionability: text(source.actionability, 40) || null,
  }
}

function shadowProjection(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  return Object.fromEntries(
    OPPORTUNITY_SHADOW_FEATURE_NAMES.map((name) => [
      name,
      finite(source[name]) ?? 0,
    ]),
  )
}

function eventProjection(value, context) {
  const code = text(value?.code, 6)
  if (!/^\d{6}$/.test(code)) {
    throw new Error('机会雷达账本股票代码无效')
  }
  const stageReached = STAGES.has(value?.stageReached)
    ? value.stageReached
    : 'PREFILTER'
  const rule = resolveAshareTradingRule({
    code,
    name: value?.name,
    tradeDate: context.tradeDate,
  })
  return {
    decisionId:
      `formula:${context.tradeDate}:${context.mode}:`
      + `${context.slot}:${code}`,
    asOf: context.generatedAt,
    code,
    name: text(value?.name, 60),
    mode: context.mode.toUpperCase(),
    stageReached,
    displayedRank: stageReached === 'DISPLAYED'
      ? Math.max(1, Math.trunc(finite(value?.displayedRank) || 1))
      : null,
    ruleVersion: rule.ruleVersion,
    formulaVersion: text(
      value?.formulaVersion || 'formula-selection.v1',
      60,
    ),
    quote: quoteProjection(value?.quote),
    cheapScore: finite(value?.cheapScore),
    shadowFeatures: shadowProjection(value?.shadowFeatures),
    formulaEvaluations: (
      Array.isArray(value?.formulaEvaluations)
        ? value.formulaEvaluations
        : []
    ).map(formulaProjection).slice(0, 4),
    decision: decisionProjection(value?.decision),
    sector: sectorProjection(value?.sector),
    rejectionReasons: uniqueText(value?.rejectionReasons),
  }
}

export function buildOpportunityRadarLedgerBatch({
  mode,
  tradeDate,
  slot,
  generatedAt = Date.now(),
  universe = {},
  marketGate = null,
  events = [],
} = {}) {
  const normalizedMode = safeMode(mode)
  const date = safeDate(tradeDate)
  const normalizedSlot = safeSlot(slot)
  const timestamp = Number(generatedAt)
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error('机会雷达账本时间无效')
  }
  const context = {
    mode: normalizedMode,
    tradeDate: date,
    slot: normalizedSlot,
    generatedAt: timestamp,
  }
  const projected = (Array.isArray(events) ? events : [])
    .map((event) => eventProjection(event, context))
  const codes = new Set()
  for (const event of projected) {
    if (codes.has(event.code)) {
      throw new Error(`机会雷达账本存在重复股票: ${event.code}`)
    }
    codes.add(event.code)
  }
  const count = (stage) =>
    projected.filter((event) => event.stageReached === stage).length
  return {
    schemaVersion: OPPORTUNITY_RADAR_LEDGER_SCHEMA_VERSION,
    runId: `${date}:${normalizedMode}:${normalizedSlot}`,
    generatedAt: timestamp,
    mode: normalizedMode.toUpperCase(),
    tradeDate: date,
    slot: normalizedSlot,
    universe: {
      total: Math.max(0, Math.trunc(finite(universe.total) || 0)),
      inspectedCount:
        Math.max(0, Math.trunc(finite(universe.inspectedCount) || 0)),
      prefilterCount:
        Math.max(0, Math.trunc(finite(universe.prefilterCount) || 0)),
      technicalCandidateCount: Math.max(
        0,
        Math.trunc(finite(universe.technicalCandidateCount) || 0),
      ),
      formulaMatchCount: Math.max(
        0,
        Math.trunc(finite(universe.formulaMatchCount) || 0),
      ),
    },
    marketGate: marketGate && typeof marketGate === 'object'
      ? {
          allowed: marketGate.allowed === true,
          riskTier: text(marketGate.riskTier, 30) || null,
          regimeLabel:
            text(marketGate.regime?.label, 60) || null,
          blockers: uniqueText(marketGate.blockers, 8),
        }
      : null,
    summary: {
      total: projected.length,
      prefilter: count('PREFILTER'),
      technical: count('TECHNICAL'),
      evidence: count('EVIDENCE'),
      displayed: count('DISPLAYED'),
      priceContracts: projected.filter(
        (event) => event.decision.priceContractValid,
      ).length,
    },
    events: projected,
  }
}
