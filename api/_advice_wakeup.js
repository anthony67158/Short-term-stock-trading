import { actionIntentOf } from '../shared/judgeAdviceContext.js'
import { isAdviceReviewEnabled } from '../shared/adviceReviewPolicy.js'
import { t1StatusOf } from './_portfolio.js'
import { enqueueJob, needsWorkerDispatch } from './_jobs.js'
import {
  createExecutionEvent,
  processExecutionEvent,
} from '../shared/executionEvents.js'
import {
  TRIGGERED_REVIEW_TIME_LIMIT_MINUTES,
  TRIGGERED_REVIEW_TOTAL_BUDGET_MS,
} from '../shared/triggeredReviewDecision.js'
import { isFreshAlertQuote } from '../shared/alertQuotePolicy.js'

const PRICE_OPERATOR_LABEL = Object.freeze({
  gte: '≥',
  lte: '≤',
})

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

export function activatePriceReviewTrigger(
  data,
  request = {},
  now = Date.now(),
) {
  const alerts = Array.isArray(data?.alerts) ? data.alerts : []
  const alertId = String(request?.alertId || '')
  const code = String(request?.code || '')
  const alert = alerts.find((item) =>
    String(item?.id || '') === alertId
    && String(item?.code || '') === code
  )
  if (!alert) return { ok: false, reason: 'alert-missing' }
  if (!alert.reviewOnly) {
    return { ok: false, reason: 'not-review-alert' }
  }
  if (alert.phase === 'reviewing') {
    const queued = queueAdviceReviewForPriceTrigger(
      data,
      alert,
      Number(alert.triggeredAt) || now,
    )
    return {
      ok: queued.queued === true,
      ...queued,
      already: queued.created !== true,
      alert: { ...alert },
    }
  }
  if (!alert.enabled || alert.triggeredAt) {
    return { ok: false, reason: 'alert-not-armed' }
  }
  if (!isAdviceReviewEnabled(data?.settings, code)) {
    return { ok: false, reason: 'review-disabled' }
  }
  if (!isCurrentAdvicePlan(alert, data?.advice?.[code])) {
    return { ok: false, reason: 'stale-plan' }
  }
  const quote = request?.quote
  if (!isFreshAlertQuote(quote, now)) {
    return { ok: false, reason: 'stale-quote' }
  }
  const price = Number(quote.price)
  const threshold = Number(alert.value)
  const crossed = alert.op === 'gte'
    ? price >= threshold
    : alert.op === 'lte'
      ? price <= threshold
      : false
  if (!(threshold > 0) || !crossed) {
    return { ok: false, reason: 'price-not-reached' }
  }

  Object.assign(alert, {
    phase: 'reviewing',
    triggeredAt: now,
    triggeredMsg:
      `观察价已到：现价 ${price} ${PRICE_OPERATOR_LABEL[alert.op]} ${threshold}`,
    decisionPrice: price,
    decisionDeadlineAt:
      now + TRIGGERED_REVIEW_TOTAL_BUDGET_MS,
    enabled: false,
  })
  const queued = queueAdviceReviewForPriceTrigger(data, alert, now)
  return {
    ok: queued.queued === true,
    ...queued,
    alert: { ...alert },
  }
}

export function queueAdviceReviewForPriceTrigger(
  data,
  alert,
  now = Date.now(),
) {
  const code = String(alert?.code || '')
  if (!code) return { queued: false, reason: 'missing-code' }
  if (!alert?.reviewOnly) {
    return { queued: false, reason: 'not-review-alert' }
  }
  if (!isAdviceReviewEnabled(data?.settings, code)) {
    return { queued: false, reason: 'review-disabled' }
  }
  if (!isCurrentAdvicePlan(alert, data?.advice?.[code])) {
    return { queued: false, reason: 'stale-plan' }
  }
  const holding = Array.isArray(data?.holding) ? data.holding : []
  const holdingReview = Number(
    t1StatusOf(holding, data?.closed || [], code).liveQty,
  ) > 0
  const mode = holdingReview ? 'hold_advice' : 'buy_advice'
  const rawIntent = alert?.reviewIntent || {}
  const intendedAction = String(rawIntent.plannedAction || '')
  const entryConfirmation = (
    rawIntent.mode === 'ENTRY_CONFIRMATION'
    && rawIntent.directionApproved === true
    && ['PROBE', 'BUY', 'PROBE_ADD', 'ADD'].includes(
      intendedAction,
    )
  )
  const maxPositionPct = Number(rawIntent.maxPositionPct)
  const reviewIntent = entryConfirmation
    ? {
        reviewMode: 'ENTRY_CONFIRMATION',
        plannedAction: intendedAction,
        actionLabel: String(
          rawIntent.actionLabel || '条件试仓',
        ).slice(0, 40),
        directionApproved: true,
        maxPositionPct: Number.isFinite(maxPositionPct)
          && maxPositionPct > 0
          ? Math.min(5, maxPositionPct)
          : null,
        manualConfirmationOnly:
          rawIntent.manualConfirmationOnly === true,
      }
    : {
        reviewMode: 'REASSESSMENT',
        plannedAction: 'WATCH',
        actionLabel: holdingReview
          ? '重新评估加仓'
          : '观望',
        directionApproved: false,
        maxPositionPct: Number.isFinite(maxPositionPct)
          && maxPositionPct > 0
          ? Math.min(100, maxPositionPct)
          : null,
        manualConfirmationOnly: false,
      }
  const trigger = {
    kind: 'price-review',
    decision: 'review',
    alertId: String(alert?.id || ''),
    planId: String(alert?.judgeContext?.planId || ''),
    planRevision:
      Number(alert?.judgeContext?.planRevision) || 0,
    direction: String(alert?.op || ''),
    threshold: Number.isFinite(Number(alert?.value))
      ? Number(alert.value)
      : null,
    price: Number.isFinite(Number(alert?.decisionPrice))
      ? Number(alert.decisionPrice)
      : null,
    ...reviewIntent,
    reason: entryConfirmation
      ? holdingReview
        ? '条件加仓价已触发，只确认加仓时机并生成具体执行价'
        : '条件建仓价已触发，只确认入场时机并生成具体执行价'
      : holdingReview
        ? '持仓加仓复核价已触发，重新评估是否加仓'
        : '观察价已触发，重新评估买入方向',
    at: now,
    timeLimitMinutes: TRIGGERED_REVIEW_TIME_LIMIT_MINUTES,
    decisionDeadlineAt:
      now + TRIGGERED_REVIEW_TOTAL_BUDGET_MS,
    terminalRequired: true,
  }
  const idempotencyKey = [
    'price-review',
    trigger.alertId || code,
    trigger.planId || 'no-plan',
    trigger.planRevision || 0,
    trigger.direction,
    trigger.threshold,
  ].join(':')
  const queued = enqueueJob(data, {
    code,
    name: alert?.name || code,
    mode,
    source: 'judge',
    trigger,
    idempotencyKey,
  }, now)
  return {
    queued: true,
    created: queued.created,
    deferred: !!queued.deferred,
    workerNeeded: needsWorkerDispatch(data),
    job: queued.job,
  }
}

export function queueAdviceReviewForVerdict(data, alert, verdict, now = Date.now()) {
  const decision = String(verdict?.decision || '')
  if (!['confirm', 'invalid'].includes(decision)) {
    return { queued: false, reason: 'non-decisive' }
  }
  const code = String(alert?.code || '')
  if (!code) return { queued: false, reason: 'missing-code' }
  if (!isAdviceReviewEnabled(data?.settings, code)) {
    return { queued: false, reason: 'review-disabled' }
  }
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
    timeLimitMinutes: TRIGGERED_REVIEW_TIME_LIMIT_MINUTES,
    decisionDeadlineAt:
      now + TRIGGERED_REVIEW_TOTAL_BUDGET_MS,
    terminalRequired: true,
  }
  const idempotencyKey = [
    'judge',
    trigger.alertId || code,
    trigger.planId || 'no-plan',
    trigger.planRevision || 0,
    trigger.decision,
  ].join(':')
  const event = createExecutionEvent({
    type: 'PRICE_TRIGGERED',
    code,
    planId: trigger.planId,
    sourceAsOf: String(trigger.at),
    idempotencyKey,
    payload: {
      hardRisk:
        trigger.side === 'stop'
        || verdict?.policy === 'risk-override',
      planConflict: decision === 'invalid',
      decision,
    },
  }, now)
  const processed = processExecutionEvent(
    data.executionEventState,
    event,
    now,
  )
  data.executionEventState = processed.state
  if (processed.duplicate) {
    return {
      queued: false,
      reason: 'duplicate-event',
      eventDecision: processed.decision,
    }
  }
  if (!processed.decision.runLlm) {
    return {
      queued: false,
      reason: 'deterministic-event',
      eventDecision: processed.decision,
    }
  }
  const queued = enqueueJob(data, {
    code,
    name: alert?.name || code,
    mode,
    source: 'judge',
    trigger,
    idempotencyKey,
  }, now)
  return {
    queued: true,
    created: queued.created,
    deferred: !!queued.deferred,
    workerNeeded: needsWorkerDispatch(data),
    job: queued.job,
  }
}
