import { buildAdviceReviewCycle } from './adviceReviewPolicy.js'

const CORE_FIELDS = [
  'action',
  'tier',
  'tone',
  'title',
  'shortHorizon',
  'edge',
  'crowdingRisk',
  'catalystWindow',
  'reviewTrigger',
  'shortHorizonTactical',
  'actionPlan',
  'exitTiming',
  'opQty',
  'addPrice',
  'buyPrice',
  'buyZone',
  'watchPrice',
  'pullbackWatchPrice',
  'breakoutWatchPrice',
  'reducePrice',
  'stopPrice',
  'targetPrice',
  'riskReward',
  'positionNote',
  'posAfter',
  'invalidation',
  'priceContract',
  'knowledgeActionPlan',
  'knowledgeActionScore',
]

const SCHEDULED_STABLE_FIELDS = [
  'action',
  'tier',
  'tone',
  'opQty',
  'positionNote',
  'posAfter',
]

const SCHEDULED_ACTION_TEXT_FIELDS = [
  'title',
  'actionPlan',
  'exitTiming',
  'invalidation',
  'knowledgeActionPlan',
  'knowledgeActionScore',
]

const EXECUTION_PRICE_FIELDS = [
  'addPrice',
  'buyPrice',
  'watchPrice',
  'pullbackWatchPrice',
  'breakoutWatchPrice',
  'reducePrice',
  'stopPrice',
  'targetPrice',
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

function boundedScheduledPrice(field, previous, proposed, evidence, direction) {
  const prior = number(previous)
  const next = number(proposed)
  if (prior == null || next == null) return proposed
  const atr = number(evidence?.atr)
  const maxMove = Math.max(prior * 0.015, atr != null ? atr * 0.75 : 0)
  let bounded = Math.max(prior - maxMove, Math.min(prior + maxMove, next))
  if (field === 'stopPrice' && direction === 'long') {
    bounded = Math.max(prior, bounded)
  }
  const digits = prior < 10 ? 3 : 2
  return +bounded.toFixed(digits)
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

function actionRiskLevel(advice = {}) {
  const action = text(advice.action || advice.stance, 80)
  if (/减仓|清仓|卖出|止损|离场/.test(action)) return 0
  if (/观望|等待|不买|暂不/.test(action)) return 1
  if (/持有|持股/.test(action)) return 2
  if (/买入|加仓|补仓|接回|买回/.test(action)) return 3
  return 2
}

function scheduledActionEvidence(previous, next, evidence = {}) {
  const priorRisk = actionRiskLevel(previous)
  const nextRisk = actionRiskLevel(next)
  if (nextRisk <= priorRisk) return { allowed: false, reason: '' }
  const current = number(evidence.currentPrice)
  const entry = number(
    previous.addPrice
    ?? previous.buyPrice
  )
  const pullback = number(
    previous.pullbackWatchPrice
    ?? previous.watchPrice,
  )
  const breakout = number(previous.breakoutWatchPrice)
  const entryTriggered = current != null && (
    (
      entry != null
      && current <= entry * 1.002
    )
    || (
      pullback != null
      && current <= pullback * 1.002
    )
    || (
      breakout != null
      && current >= breakout * 0.998
    )
  )
  const sectorConfirmed = evidence.sectorProbeEligible === true
  const fundsConfirmed = (
    Number(evidence.mainNetYi) > 0
    || Number(evidence.mainStreak) >= 1
  )
  if (entryTriggered && sectorConfirmed && fundsConfirmed) {
    return {
      allowed: true,
      reason: '执行价已触发，板块前排与主力资金同步确认',
    }
  }
  return {
    allowed: false,
    reason: '新增风险仍缺执行价、板块前排或主力资金确认',
  }
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
    mainNetYi: payload.stockFund?.mainNetYi ?? null,
    retailNetYi: payload.stockFund?.retailNetYi
      ?? payload.stockFund?.smallNetYi
      ?? null,
    sectorProbeEligible:
      payload.sectorOpportunity?.probeEligible === true,
    highConfFired: !!quant.highConfSignal?.fired,
    atr: payload.tech?.atr?.atr ?? payload.tech?.atr ?? null,
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
    const actionChanged = text(prior.action || prior.stance, 80)
      !== text(nextAdvice.action || nextAdvice.stance, 80)
    const actionEvidence = scheduledActionEvidence(
      prior,
      nextAdvice,
      evidence,
    )
    if (!actionEvidence.allowed) {
      for (const field of SCHEDULED_STABLE_FIELDS) {
        if (prior[field] != null) held[field] = prior[field]
        else delete held[field]
      }
    }
    if (actionChanged && !actionEvidence.allowed) {
      for (const field of SCHEDULED_ACTION_TEXT_FIELDS) {
        if (prior[field] != null) held[field] = prior[field]
        else delete held[field]
      }
    }
    for (const field of EXECUTION_PRICE_FIELDS) {
      if (nextAdvice[field] == null) continue
      held[field] = boundedScheduledPrice(
        field,
        prior[field],
        nextAdvice[field],
        evidence,
        previousDirection,
      )
    }
    const changeType = coreChanged(prior, held) ? 'adjust' : 'maintain'
    held.continuity = {
      planId,
      revision,
      thesisVersion: priorThesis,
      changeType,
      changeReason: changeType === 'adjust'
        ? actionChanged && actionEvidence.allowed
          ? actionEvidence.reason
          : '自动复核确认方向不变，按最新风险与波动受控更新执行价位'
        : '自动复核未发现执行事件，继续执行上一版主计划',
      previousAction: prior.action || '',
      proposedAction: actionChanged && !actionEvidence.allowed
        ? nextAdvice.action || nextAdvice.stance || ''
        : '',
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
