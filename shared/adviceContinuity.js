import { buildAdviceReviewCycle } from './adviceReviewPolicy.js'

const CORE_FIELDS = [
  'action',
  'tier',
  'tone',
  'title',
  'actionPlan',
  'exitTiming',
  'opQty',
  'addPrice',
  'buyPrice',
  'buyZone',
  'watchPrice',
  'reducePrice',
  'stopPrice',
  'targetPrice',
  'riskReward',
  'positionNote',
  'posAfter',
  'invalidation',
  'knowledgeActionPlan',
  'knowledgeActionScore',
]

const number = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const text = (value, max = 1200) =>
  String(value || '').trim().slice(0, max)

function directionOf(advice = {}) {
  const action = text(advice.action || advice.stance, 80)
  if (/减仓|清仓|卖出|止损|离场/.test(action)) return 'defensive'
  if (/买入|加仓|补仓|接回|买回|持有|持股/.test(action)) return 'long'
  return 'neutral'
}

function priceZone(value) {
  const anchor = number(value)
  if (anchor == null) return null
  const width = anchor * 0.006
  const digits = anchor < 10 ? 3 : 2
  return {
    low: +(anchor - width).toFixed(digits),
    high: +(anchor + width).toFixed(digits),
    anchor: +anchor.toFixed(digits),
  }
}

function zonesOf(advice = {}) {
  return {
    add: priceZone(advice.addPrice ?? advice.buyPrice),
    reduce: priceZone(advice.reducePrice),
    stop: priceZone(advice.stopPrice),
    target: priceZone(advice.targetPrice),
  }
}

function coreChanged(previous, next) {
  return CORE_FIELDS.some((field) =>
    JSON.stringify(previous?.[field] ?? null)
      !== JSON.stringify(next?.[field] ?? null)
  )
}

function reversalEvidence(previous, next, evidence = {}) {
  const from = directionOf(previous)
  const to = directionOf(next)
  if (from === to || from === 'neutral' || to === 'neutral') {
    return { allowed: true, reason: '' }
  }

  const current = number(evidence.currentPrice)
  const stop = number(previous.stopPrice)
  const target = number(previous.targetPrice ?? previous.reducePrice)
  if (from === 'long' && to === 'defensive') {
    if (current != null && stop != null && current <= stop * 1.002) {
      return { allowed: true, reason: `现价已触及上一版止损${stop}` }
    }
    if (current != null && target != null && current >= target * 0.998) {
      return { allowed: true, reason: `现价已触及上一版目标${target}` }
    }
    if (evidence.isLimitDown) {
      return { allowed: true, reason: '今日跌停构成客观转弱' }
    }
    if (
      Number(evidence.resonanceScore) <= 1
      && evidence.hasNegNews
      && Number(evidence.mainStreak) <= -2
    ) {
      return { allowed: true, reason: '利空、低共振与资金连续流出共同确认转弱' }
    }
  }
  if (from === 'defensive' && to === 'long') {
    if (evidence.highConfFired) {
      return { allowed: true, reason: '高把握量化信号已触发' }
    }
    if (evidence.isLimitUp) {
      return { allowed: true, reason: '今日涨停构成客观转强' }
    }
    if (
      Number(evidence.resonanceScore) >= 4
      && !evidence.hasNegNews
      && Number(evidence.mainStreak) >= 1
    ) {
      return { allowed: true, reason: '高共振与资金流入共同确认转强' }
    }
  }
  return { allowed: false, reason: '' }
}

export function compactAdvicePlan(entry) {
  const advice = entry?.advice && typeof entry.advice === 'object'
    ? entry.advice
    : entry
  if (!advice || typeof advice !== 'object') return null
  const continuity = advice.continuity || {}
  const compact = {
    at: Number(entry?.at || advice.at) || null,
    planId: text(continuity.planId, 120),
    revision: Number(continuity.revision) || 0,
    thesisVersion: Number(continuity.thesisVersion) || 0,
  }
  for (const field of CORE_FIELDS) {
    const value = advice[field]
    if (value == null || value === '') continue
    compact[field] = typeof value === 'string' ? text(value) : value
  }
  return compact.action || compact.title || compact.planId ? compact : null
}

export function buildAdviceCacheEntry(previous, data, at = Date.now()) {
  const prior = compactAdvicePlan(previous)
  const existingTrail = Array.isArray(previous?.trail)
    ? previous.trail.filter(Boolean)
    : []
  const hasIncomingAdvice = !!(
    data?.advice
    && typeof data.advice === 'object'
  )
  const appendTrail = hasIncomingAdvice
    && !['unchanged', 'insufficient'].includes(data?.reviewDisposition)
  const trail = prior && appendTrail
    ? [...existingTrail, prior].slice(-8)
    : existingTrail.slice(-8)
  const reviewCycle = buildAdviceReviewCycle(previous, data, at)
  const retainedAdvice = hasIncomingAdvice
    ? data.advice
    : previous?.advice && typeof previous.advice === 'object'
      ? previous.advice
      : null
  const nextData = {
    ...(data || {}),
    reviewCycle,
    ...(retainedAdvice
      ? {
          advice: {
            ...retainedAdvice,
            reviewCycle,
          },
        }
      : {}),
  }
  return {
    ...nextData,
    at,
    ...(trail.length ? { trail } : {}),
  }
}

export function continuityEvidenceFromPayload(payload = {}) {
  const quant = payload.quant || {}
  return {
    currentPrice: payload.todayQuote?.price
      ?? payload.intraday?.now
      ?? quant.price
      ?? null,
    isLimitUp: !!payload.todayQuote?.isLimitUp,
    isLimitDown: !!payload.todayQuote?.isLimitDown,
    resonanceScore: payload.resonance?.score ?? null,
    hasNegNews: !!payload.resonance?.hasNegNews,
    mainStreak: payload.stockFund?.mainStreak ?? null,
    highConfFired: !!quant.highConfSignal?.fired,
  }
}

export function reconcileAdviceContinuity({
  code,
  previous,
  next,
  evidence = {},
  stabilityMode = '',
  now = Date.now(),
} = {}) {
  const nextAdvice = next && typeof next === 'object' ? { ...next } : {}
  const prior = compactAdvicePlan(previous)
  if (!prior) {
    const planId = `plan-${String(code || 'unknown')}-${Number(now)}`
    const advice = {
      ...nextAdvice,
      continuity: {
        planId,
        revision: 1,
        thesisVersion: 1,
        changeType: 'initial',
        changeReason: '首次建立主计划',
        previousAction: '',
        proposedAction: '',
        zones: zonesOf(nextAdvice),
      },
    }
    return { advice, accepted: true }
  }

  const previousDirection = directionOf(prior)
  const nextDirection = directionOf(nextAdvice)
  const reversal = previousDirection !== nextDirection
    && previousDirection !== 'neutral'
    && nextDirection !== 'neutral'
  const proof = reversalEvidence(prior, nextAdvice, evidence)
  const planId = prior.planId
    || `plan-${String(code || 'unknown')}-${prior.at || Number(now)}`
  const revision = Math.max(1, Number(prior.revision) || 1) + 1
  const priorThesis = Math.max(1, Number(prior.thesisVersion) || 1)

  if (reversal && !proof.allowed) {
    const held = { ...nextAdvice }
    for (const field of CORE_FIELDS) {
      if (prior[field] != null) held[field] = prior[field]
      else delete held[field]
    }
    held.continuity = {
      planId,
      revision,
      thesisVersion: priorThesis,
      changeType: 'blocked',
      changeReason: '新建议与主计划方向冲突，但尚无止损、目标位或多维反转证据，继续以上一版为准',
      previousAction: prior.action || '',
      proposedAction: nextAdvice.action || nextAdvice.stance || '',
      proposedReason: text(
        nextAdvice.changeReason
          || nextAdvice.reason
          || nextAdvice.title,
        400,
      ),
      zones: zonesOf(held),
    }
    return { advice: held, accepted: false }
  }

  if (stabilityMode === 'scheduled' && !reversal) {
    const held = { ...nextAdvice }
    for (const field of CORE_FIELDS) {
      if (prior[field] != null) held[field] = prior[field]
      else delete held[field]
    }
    held.continuity = {
      planId,
      revision,
      thesisVersion: priorThesis,
      changeType: 'maintain',
      changeReason: '自动复核未发现执行事件，锁定上一版动作与价位，避免计划频繁漂移',
      previousAction: prior.action || '',
      proposedAction: '',
      zones: zonesOf(held),
    }
    return { advice: held, accepted: true }
  }

  const changeType = reversal
    ? 'reverse'
    : coreChanged(prior, nextAdvice) ? 'adjust' : 'maintain'
  nextAdvice.continuity = {
    planId,
    revision,
    thesisVersion: reversal ? priorThesis + 1 : priorThesis,
    changeType,
    changeReason: proof.reason
      || text(nextAdvice.changeReason, 400)
      || (changeType === 'maintain' ? '主计划延续' : '方向不变，按最新行情调整执行区间'),
    previousAction: prior.action || '',
    proposedAction: '',
    zones: zonesOf(nextAdvice),
  }
  return { advice: nextAdvice, accepted: true }
}
