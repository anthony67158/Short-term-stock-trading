import {
  resolveAshareTradingRule,
} from './priceLimitPolicy.js'

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
  return {
    price: finite(value.price),
    pct: finite(value.pct),
    amount: finite(value.amount),
    turnover: finite(value.turnover),
    volumeRatio: finite(value.volumeRatio),
    mainRatio: finite(value.mainRatio),
    tradeDate: text(value.tradeDate, 10) || null,
  }
}

function formulaProjection(value = {}) {
  return {
    formulaId: text(value.formulaId, 60),
    matched: value.matched === true,
    score: finite(value.score),
    priceType: text(value.priceType, 40) || null,
    blockers: uniqueText(value.blockers),
  }
}

function decisionProjection(value = {}) {
  return {
    action: text(value.action, 40),
    formulaId: text(value.formulaId, 60) || null,
    primaryPrice: finite(value.primaryPrice),
    priceType: text(value.priceType, 40) || null,
    stopPrice: finite(value.stopPrice),
    targetPrice: finite(value.targetPrice),
    riskReward: finite(value.riskReward),
    priceContractValid: value.priceContractValid === true,
    marketAllowsRisk: value.marketAllowsRisk === true,
    executionState: text(value.executionState, 40) || null,
  }
}

function sectorProjection(value = {}) {
  return {
    code: text(value.code, 20),
    name: text(value.name, 60),
    phase: text(value.phase, 40) || null,
    actionability: text(value.actionability, 40) || null,
  }
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
