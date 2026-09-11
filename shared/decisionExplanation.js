import {
  isDecisionEngineAdvice,
} from './decisionEngineSource.js'

export const DECISION_EXPLANATION_SCHEMA_VERSION =
  'decision-explanation.v1'

const OUTPUT_FIELDS = new Set([
  'summary',
  'counterCase',
  'invalidation',
  'evidenceGap',
])

function clean(value, maximum = 320) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function evidenceValues(values) {
  return (Array.isArray(values) ? values : [])
    .slice(-5)
    .map((value) => finite(value))
}

function evidenceGaps(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((item) => clean(item, 180))
      .filter(Boolean),
  )].slice(0, 8)
}

function projectDecisionEvidence(value) {
  if (!value || typeof value !== 'object') return null
  const availability = value.availability || {}
  const technical = value.technical || {}
  const funds = value.funds || {}
  const sector = value.sector || {}
  const market = value.market || {}
  return {
    asOf: finite(value.asOf),
    availability: {
      dailyTechnical: availability.dailyTechnical === true,
      intradayTechnical: availability.intradayTechnical === true,
      currentFund: availability.currentFund === true,
      fundHistory: availability.fundHistory === true,
      completeFundHistory: availability.completeFundHistory === true,
      sectorContext: availability.sectorContext === true,
      marketBreadth: availability.marketBreadth === true,
    },
    technical: {
      quotePct: finite(technical.quotePct),
      ret2dPct: finite(technical.ret2dPct),
      ret5dPct: finite(technical.ret5dPct),
      atrPct: finite(technical.atrPct),
      vwapDistancePct: finite(technical.vwapDistancePct),
      intradayRangePct: finite(technical.intradayRangePct),
    },
    funds: {
      asOfDate: clean(funds.asOfDate, 16) || null,
      mainNetYi: finite(funds.mainNetYi),
      retailNetYi: finite(funds.retailNetYi),
      historyDayCount: finite(funds.historyDayCount),
      historyComplete: funds.historyComplete === true,
      mainTrend5: evidenceValues(funds.mainTrend5),
      retailTrend5: evidenceValues(funds.retailTrend5),
      main5dYi: finite(funds.main5dYi),
      retail5dYi: finite(funds.retail5dYi),
      mainInflowDays5: finite(funds.mainInflowDays5),
      retailInflowDays5: finite(funds.retailInflowDays5),
      mainStreak5: finite(funds.mainStreak5),
      retailStreak5: finite(funds.retailStreak5),
    },
    sector: {
      matched: sector.matched === true,
      code: clean(sector.code, 20) || null,
      name: clean(sector.name, 60) || null,
      phase: clean(sector.phase, 40) || null,
      actionability: clean(sector.actionability, 40) || null,
      rank: finite(sector.rank),
      mainNetYi: finite(sector.mainNetYi),
      breadthPct: finite(sector.breadthPct),
    },
    market: {
      up: finite(market.up),
      down: finite(market.down),
      flat: finite(market.flat),
    },
    knownGaps: evidenceGaps(value.knownGaps),
  }
}

export function currentDecisionAdvice(accountData, code, decisionId) {
  if (!/^\d{6}$/.test(String(code || '')) || !decisionId) return null
  const entry = accountData?.advice?.[code]
  const advice = entry?.advice
  if (
    !isDecisionEngineAdvice(advice)
    || advice?.decisionPlan?.decisionId !== decisionId
  ) return null
  return { entry, advice }
}

export function cachedDecisionExplanation(advice, decisionId) {
  const value = advice?.decisionExplanation ?? advice?.v3Explanation
  return [
    DECISION_EXPLANATION_SCHEMA_VERSION,
    'v3-explanation.v2',
  ].includes(value?.schemaVersion)
    && value.decisionId === decisionId
    && ['ready', 'failed', 'running'].includes(value.status)
    ? value
    : null
}

export function buildDecisionExplanationPacket(advice = {}) {
  const plan = advice.decisionPlan || {}
  const score = (
    advice.selectedDecisionPlan
    ?? advice.selectedV3Plan
  )?.opportunityScore || {}
  const evidence = projectDecisionEvidence(advice.decisionEvidence)
  const knownGaps = evidence?.knownGaps
    || evidenceGaps(advice.decisionSource?.missingEvidence)
  const evidenceFacts = evidence
    ? Object.fromEntries(
        Object.entries(evidence)
          .filter(([name]) => name !== 'knownGaps'),
      )
    : null
  return {
    schemaVersion: 'decision-explanation-packet.v1',
    decisionId: plan.decisionId,
    action: plan.action,
    actionability: plan.actionability,
    quantityLots: Math.max(0, Math.trunc(finite(plan.quantity?.lots) || 0)),
    prices: {
      reference: finite(plan.prices?.reference),
      stop: finite(plan.prices?.stop),
      target: finite(plan.prices?.target),
    },
    model: {
      version: clean(advice.decisionSource?.modelVersion, 100),
      pFill: finite(score.pFill),
      pWinGivenFill: finite(score.pWinGivenFill),
      expectedNetR: finite(score.expectedNetR),
      netRLowerBound: finite(score.netRLowerBound),
      expectedShortfall10: finite(score.expectedShortfall10),
      outOfDistribution: score.outOfDistribution === true,
    },
    facts: {
      actionPlan: clean(advice.actionPlan, 500),
      quant: clean(advice.quantNote, 500),
      funds: clean(advice.fundNote, 500),
      invalidation: clean(advice.invalidation, 400),
      blockedReasons: (plan.blockedReasons || [])
        .map((item) => clean(item, 180))
        .filter(Boolean)
        .slice(0, 6),
      evidence: evidenceFacts,
      knownGaps,
    },
  }
}

export function normalizeDecisionExplanation(value, {
  decisionId,
  model,
  now = Date.now(),
  evidenceGaps: authoritativeEvidenceGaps,
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('模型解读返回格式无效')
  }
  const extra = Object.keys(value).filter((key) => !OUTPUT_FIELDS.has(key))
  if (extra.length) throw new Error('模型解读包含越权字段')
  const authoritativeGap = Array.isArray(authoritativeEvidenceGaps)
    ? clean(
        evidenceGaps(authoritativeEvidenceGaps).join('；') || '无',
        240,
      )
    : null
  const explanation = {
    schemaVersion: DECISION_EXPLANATION_SCHEMA_VERSION,
    status: 'ready',
    decisionId: clean(decisionId, 120),
    model: clean(model, 100),
    generatedAt: Number(now) || Date.now(),
    summary: clean(value.summary, 320),
    counterCase: clean(value.counterCase, 320),
    invalidation: clean(value.invalidation, 320),
    evidenceGap: authoritativeGap ?? clean(value.evidenceGap, 240),
  }
  if (!explanation.decisionId || ![
    explanation.summary,
    explanation.counterCase,
    explanation.invalidation,
    explanation.evidenceGap,
  ].every(Boolean)) {
    throw new Error('模型解读字段不完整')
  }
  return explanation
}

export function failedDecisionExplanation(decisionId, error, now = Date.now()) {
  return {
    schemaVersion: DECISION_EXPLANATION_SCHEMA_VERSION,
    status: 'failed',
    decisionId: clean(decisionId, 120),
    generatedAt: Number(now) || Date.now(),
    error: clean(error || '模型解读暂不可用', 160),
  }
}
