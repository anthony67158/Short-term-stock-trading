export const V3_EXPLANATION_SCHEMA_VERSION = 'v3-explanation.v1'

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

export function currentV3Advice(accountData, code, decisionId) {
  if (!/^\d{6}$/.test(String(code || '')) || !decisionId) return null
  const entry = accountData?.advice?.[code]
  const advice = entry?.advice
  if (
    advice?.decisionSource?.engine !== 'V3'
    || advice?.decisionPlan?.decisionId !== decisionId
  ) return null
  return { entry, advice }
}

export function cachedV3Explanation(advice, decisionId) {
  const value = advice?.v3Explanation
  return value?.schemaVersion === V3_EXPLANATION_SCHEMA_VERSION
    && value.decisionId === decisionId
    && ['ready', 'failed', 'running'].includes(value.status)
    ? value
    : null
}

export function buildV3ExplanationPacket(advice = {}) {
  const plan = advice.decisionPlan || {}
  const score = advice.selectedV3Plan?.opportunityScore || {}
  return {
    schemaVersion: 'v3-explanation-packet.v1',
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
    },
  }
}

export function normalizeV3Explanation(value, {
  decisionId,
  model,
  now = Date.now(),
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('模型解读返回格式无效')
  }
  const extra = Object.keys(value).filter((key) => !OUTPUT_FIELDS.has(key))
  if (extra.length) throw new Error('模型解读包含越权字段')
  const explanation = {
    schemaVersion: V3_EXPLANATION_SCHEMA_VERSION,
    status: 'ready',
    decisionId: clean(decisionId, 120),
    model: clean(model, 100),
    generatedAt: Number(now) || Date.now(),
    summary: clean(value.summary, 320),
    counterCase: clean(value.counterCase, 320),
    invalidation: clean(value.invalidation, 320),
    evidenceGap: clean(value.evidenceGap, 240),
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

export function failedV3Explanation(decisionId, error, now = Date.now()) {
  return {
    schemaVersion: V3_EXPLANATION_SCHEMA_VERSION,
    status: 'failed',
    decisionId: clean(decisionId, 120),
    generatedAt: Number(now) || Date.now(),
    error: clean(error || '模型解读暂不可用', 160),
  }
}
