import { actionIntentOf, actionLabelOf } from './judgeAdviceContext.js'

const POSITION_INTENTS = new Set(['add', 'reduce', 'sell', 'stop'])

function finiteNonNegative(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

function holdingIdSet(value) {
  if (value instanceof Set) return value
  return new Set((Array.isArray(value) ? value : []).map((id) => String(id)))
}

export function requiresLivePosition(alert = {}) {
  return !!alert.planId || POSITION_INTENTS.has(actionIntentOf(alert))
}

export function requiresPositionCheck(alert = {}) {
  return !!alert.candCode || requiresLivePosition(alert)
}

export function positionGateForAlert(alert = {}, context = {}) {
  const intent = actionIntentOf(alert)
  if (!requiresPositionCheck(alert)) {
    return { allowed: true, intent, reason: '', policy: null }
  }

  if (context.verified === false) {
    return {
      allowed: false,
      transient: true,
      intent,
      reason: '实时持仓校验暂不可用，本次不推送',
      policy: 'position-unverified',
    }
  }

  const liveQty = finiteNonNegative(context.liveQty)
  const holdingIds = holdingIdSet(context.holdingIds)
  const candidateOnly = !!alert.candCode && !requiresLivePosition(alert)
  if (candidateOnly && liveQty > 0) {
    return {
      allowed: false,
      intent,
      reason: '该股已持仓，自选买点预警自动失效',
      policy: 'candidate-already-held',
    }
  }
  if (candidateOnly) {
    return { allowed: true, intent, liveQty, reason: '', policy: null }
  }
  if (alert.planId && !holdingIds.has(String(alert.planId))) {
    return {
      allowed: false,
      intent,
      reason: '对应持仓已不存在，原持仓计划预警自动失效',
      policy: 'holding-plan-missing',
    }
  }
  if (!(liveQty > 0)) {
    return {
      allowed: false,
      intent,
      reason: `当前未持有该股，不能${actionLabelOf(alert)}`,
      policy: 'position-missing',
    }
  }
  return {
    allowed: true,
    intent,
    liveQty,
    sellableToday: finiteNonNegative(context.sellableToday),
    reason: '',
    policy: null,
  }
}

export function retirePositionAlert(alert, gate, now = Date.now()) {
  if (!alert || gate?.allowed || gate?.transient) return alert
  return {
    ...alert,
    enabled: false,
    phase: 'invalid',
    retiredAt: now,
    retiredPolicy: gate?.policy || 'position-mismatch',
    retiredReason: gate?.reason || '当前持仓状态已变化，预警自动失效',
    triggeredMsg: `自动失效:${gate?.reason || '当前持仓状态已变化'}`,
    watchingAt: null,
    watchingPrice: null,
    watchingMsg: '',
  }
}
