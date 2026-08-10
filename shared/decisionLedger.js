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
  }
}

export function appendExecution(ledger, input = {}, now = Date.now()) {
  const events = Array.isArray(ledger) ? ledger : []
  const at = Number(input.at) || now
  const side = input.side === 'sell' ? 'sell' : 'buy'
  const candidates = events.filter((event) =>
    event &&
    event.kind === 'recommendation' &&
    event.code === input.code &&
    (event.status === 'pending' || event.status === 'accepted') &&
    at >= event.at &&
    at - event.at <= DAY_MS &&
    actionSide(event.action) === side
  ).sort((a, b) => b.at - a.at)
  const linked = candidates[0] || null
  const execution = {
    ...input,
    id: input.id || eventId('exec', input.code || 'unknown', at),
    kind: 'execution',
    side,
    at,
    source: input.source || 'manual',
    linkedRecommendationId: linked ? linked.id : null,
    linkType: linked ? 'inferred' : null,
  }
  const updated = events.map((event) => event === linked ? {
    ...event,
    status: 'executed',
    executedAt: at,
    linkedExecutionId: execution.id,
  } : event)
  return [execution, ...updated].slice(0, 1000)
}

export function decisionLedgerStats(ledger) {
  const events = Array.isArray(ledger) ? ledger : []
  const recommendations = events.filter((event) => event && event.kind === 'recommendation')
  const actionable = recommendations.filter((event) => event.isActionable !== false && (event.side || actionSide(event.action)))
  const executions = events.filter((event) => event && event.kind === 'execution')
  const executedRecommendations = actionable.filter((event) => event.status === 'executed').length
  return {
    recommendations: recommendations.length,
    actionableRecommendations: actionable.length,
    pending: actionable.filter((event) => event.status === 'pending').length,
    executedRecommendations,
    executions: executions.length,
    linkedExecutions: executions.filter((event) => event.linkedRecommendationId).length,
    adoptionRate: actionable.length ? Math.round(executedRecommendations / actionable.length * 100) : null,
  }
}

export function removeExecutions(ledger, transactionIds) {
  const ids = new Set((transactionIds || []).filter(Boolean))
  if (!ids.size) return Array.isArray(ledger) ? ledger : []
  const events = Array.isArray(ledger) ? ledger : []
  const removedExecutionIds = new Set(events
    .filter((event) => event && event.kind === 'execution' && ids.has(event.transactionId))
    .map((event) => event.id))
  return events
    .filter((event) => !(event && event.kind === 'execution' && ids.has(event.transactionId)))
    .map((event) => event && event.kind === 'recommendation' && removedExecutionIds.has(event.linkedExecutionId)
      ? { ...event, status: 'pending', executedAt: null, linkedExecutionId: null }
      : event)
}
