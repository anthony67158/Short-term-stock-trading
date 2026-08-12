import { evaluateKnowledgeActionCycle } from './knowledgeAction.js'

const DAY_MS = 24 * 3600 * 1000

function eventId(prefix, code, at) {
  return `${prefix}_${at}_${code}_${Math.random().toString(36).slice(2, 7)}`
}

function actionSide(action) {
  const text = String(action || '')
  if (/减仓|清仓|卖出|止损|离场|回避|反T/.test(text)) return 'sell'
  if (/买入|建仓|加仓|补仓|低吸|试错|正T|回调再买/.test(text)) return 'buy'
  return null
}

function validationWindowMs(plan) {
  const match = String(plan?.validationWindow || '').match(/(\d+)/)
  const days = match ? Number(match[1]) : 3
  return Math.max(1, Math.min(10, days)) * DAY_MS
}

export function createRecommendation(input = {}, now = Date.now()) {
  const at = Number(input.at) || now
  const side = actionSide(input.action)
  return {
    ...input,
    id: input.id || eventId('rec', input.code || 'unknown', at),
    kind: 'recommendation',
    status: 'pending',
    side,
    isActionable: !!side,
    at,
    executedAt: null,
    linkedExecutionId: null,
    linkedExecutionIds: [],
  }
}

export function appendExecution(ledger, input = {}, now = Date.now()) {
  const events = Array.isArray(ledger) ? ledger : []
  const at = Number(input.at) || now
  const side = input.side === 'sell' ? 'sell' : 'buy'
  const candidates = events.filter((event) => {
    if (
      !event
      || event.kind !== 'recommendation'
      || event.code !== input.code
      || at < event.at
    ) return false
    const entryMatch = ['pending', 'accepted'].includes(event.status)
      && at - event.at <= DAY_MS
      && actionSide(event.action) === side
    if (entryMatch) return true
    const plan = event.knowledgeActionPlan
    if (!plan || at - event.at > validationWindowMs(plan)) return false
    const stop = Number(plan.stopLoss?.price)
    const target = Number(plan.takeProfit?.price)
    const price = Number(input.price)
    const longPlan = actionSide(event.action) === 'buy'
      || /持有|持股/.test(String(event.action || ''))
    const plannedExit = Number.isFinite(price) && (
      (Number.isFinite(stop) && price <= stop * 1.02 && price >= stop * 0.9)
      || (Number.isFinite(target) && price >= target * 0.995)
    )
    return side === 'sell'
      && longPlan
      && ['pending', 'accepted', 'executed'].includes(event.status)
      && plannedExit
  }).sort((a, b) => b.at - a.at)
  const linked = candidates[0] || null
  const knowledgeActionReview = linked?.knowledgeActionPlan
    ? evaluateKnowledgeActionCycle({
        plan: linked.knowledgeActionPlan,
        execution: input,
        outcome: input.outcome || {},
      })
    : null
  const execution = {
    ...input,
    id: input.id || eventId('exec', input.code || 'unknown', at),
    kind: 'execution',
    side,
    at,
    source: input.source || 'manual',
    linkedRecommendationId: linked ? linked.id : null,
    linkType: linked ? 'inferred' : null,
    ...(knowledgeActionReview ? { knowledgeActionReview } : {}),
  }
  const updated = events.map((event) => event === linked ? {
    ...event,
    status: 'executed',
    executedAt: at,
    linkedExecutionId: execution.id,
    linkedExecutionIds: [
      ...new Set([
        ...(event.linkedExecutionIds || []).filter(Boolean),
        ...(event.linkedExecutionId ? [event.linkedExecutionId] : []),
        execution.id,
      ]),
    ],
    ...(knowledgeActionReview ? { knowledgeActionReview } : {}),
  } : event)
  return [execution, ...updated].slice(0, 1000)
}

export function decisionLedgerStats(ledger) {
  const events = Array.isArray(ledger) ? ledger : []
  const recommendations = events.filter((event) => event && event.kind === 'recommendation')
  const actionable = recommendations.filter((event) => event.isActionable !== false && (event.side || actionSide(event.action)))
  const executions = events.filter((event) => event && event.kind === 'execution')
  const executedRecommendations = actionable.filter((event) => event.status === 'executed').length
  const result = {
    recommendations: recommendations.length,
    actionableRecommendations: actionable.length,
    pending: actionable.filter((event) => event.status === 'pending').length,
    executedRecommendations,
    executions: executions.length,
    linkedExecutions: executions.filter((event) => event.linkedRecommendationId).length,
    adoptionRate: actionable.length ? Math.round(executedRecommendations / actionable.length * 100) : null,
  }
  const reviewByPlan = new Map()
  for (const execution of executions) {
    if (!execution.knowledgeActionReview) continue
    const key = execution.linkedRecommendationId || execution.id
    const current = reviewByPlan.get(key)
    if (!current || (execution.at || 0) >= (current.at || 0)) {
      reviewByPlan.set(key, {
        at: execution.at || 0,
        review: execution.knowledgeActionReview,
      })
    }
  }
  const reviews = [...reviewByPlan.values()].map((item) => item.review)
  if (reviews.length) {
    const attribution = {
      plan_validated: 0,
      judgment_error: 0,
      execution_error: 0,
      randomness: 0,
    }
    for (const review of reviews) {
      if (Object.prototype.hasOwnProperty.call(attribution, review.attribution)) {
        attribution[review.attribution]++
      }
    }
    result.knowledgeAction = {
      evaluated: reviews.length,
      averagePlanScore: Math.round(
        reviews.reduce((sum, review) => sum + (Number(review.planScore) || 0), 0)
          / reviews.length,
      ),
      averageExecutionScore: Math.round(
        reviews.reduce((sum, review) => sum + (Number(review.executionScore) || 0), 0)
          / reviews.length,
      ),
      attribution,
    }
  }
  return result
}

export function removeExecutions(ledger, transactionIds) {
  const ids = new Set((transactionIds || []).filter(Boolean))
  if (!ids.size) return Array.isArray(ledger) ? ledger : []
  const events = Array.isArray(ledger) ? ledger : []
  const removedExecutionIds = new Set(events
    .filter((event) => event && event.kind === 'execution' && ids.has(event.transactionId))
    .map((event) => event.id))
  const remaining = events
    .filter((event) => !(event && event.kind === 'execution' && ids.has(event.transactionId)))
  const remainingExecutions = new Map(remaining
    .filter((event) => event?.kind === 'execution' && event.id)
    .map((event) => [event.id, event]))
  return remaining.map((event) => {
    if (!event || event.kind !== 'recommendation') return event
    const linkedIds = [
      ...new Set([
        ...(event.linkedExecutionIds || []).filter(Boolean),
        ...(event.linkedExecutionId ? [event.linkedExecutionId] : []),
      ]),
    ].filter((id) => !removedExecutionIds.has(id) && remainingExecutions.has(id))
    if (linkedIds.length === (event.linkedExecutionIds || []).length && !removedExecutionIds.has(event.linkedExecutionId)) {
      return event
    }
    const latest = linkedIds
      .map((id) => remainingExecutions.get(id))
      .sort((left, right) => (right.at || 0) - (left.at || 0))[0]
    return {
      ...event,
      status: linkedIds.length ? 'executed' : 'pending',
      executedAt: latest?.at || null,
      linkedExecutionId: latest?.id || null,
      linkedExecutionIds: linkedIds,
      knowledgeActionReview: latest?.knowledgeActionReview || null,
    }
  })
}
