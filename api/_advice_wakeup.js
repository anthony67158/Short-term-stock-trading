import { actionIntentOf } from '../shared/judgeAdviceContext.js'
import { t1StatusOf } from './_portfolio.js'
import { enqueueJob, needsWorkerDispatch } from './_jobs.js'

function decisionSideOf(alert, verdict) {
  if (verdict?.side) return String(verdict.side)
  const intent = actionIntentOf(alert)
  return intent === 'buy' || intent === 'add'
    ? 'buy'
    : intent === 'stop'
      ? 'stop'
      : 'sell'
}

export function isCurrentAdvicePlan(alert, adviceEntry) {
  const alertPlanId = String(alert?.judgeContext?.planId || '')
  if (!alertPlanId) return true
  const currentPlanId = String(adviceEntry?.advice?.continuity?.planId || '')
  return currentPlanId === alertPlanId
}

export function queueAdviceReviewForVerdict(data, alert, verdict, now = Date.now()) {
  const decision = String(verdict?.decision || '')
  if (!['confirm', 'invalid'].includes(decision)) {
    return { queued: false, reason: 'non-decisive' }
  }
  const code = String(alert?.code || '')
  if (!code) return { queued: false, reason: 'missing-code' }
  const currentAdvice = data?.advice?.[code]?.advice
  const alertPlanId = String(alert?.judgeContext?.planId || '')
  const currentPlanId = String(currentAdvice?.continuity?.planId || '')
  if (!isCurrentAdvicePlan(alert, data?.advice?.[code])) {
    return { queued: false, reason: 'stale-plan' }
  }
  const holding = Array.isArray(data?.holding) ? data.holding : []
  const mode = Number(t1StatusOf(holding, data?.closed || [], code).liveQty) > 0
    ? 'hold_advice'
    : 'buy_advice'
  const trigger = {
    kind: 'judge',
    decision,
    alertId: String(alert?.id || ''),
    planId: alertPlanId || currentPlanId,
    planRevision: Number(alert?.judgeContext?.planRevision) || 0,
    side: decisionSideOf(alert, verdict),
    confidence: Number.isFinite(Number(verdict?.confidence))
      ? Number(verdict.confidence)
      : null,
    reason: String(verdict?.reason || '').slice(0, 500),
    price: Number.isFinite(Number(alert?.decisionPrice))
      ? Number(alert.decisionPrice)
      : null,
    at: now,
  }
  const queued = enqueueJob(data, {
    code,
    name: alert?.name || code,
    mode,
    source: 'judge',
    trigger,
  }, now)
  return {
    queued: true,
    created: queued.created,
    deferred: !!queued.deferred,
    workerNeeded: needsWorkerDispatch(data),
    job: queued.job,
  }
}
