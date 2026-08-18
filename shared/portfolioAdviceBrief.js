const ACTION_LABELS = Object.freeze({
  reduce: '减持',
  exit: '退出',
  add: '加仓',
  buy: '新买',
  hold: '持有',
  watch: '观察',
})

function text(value, maximum = 100) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length <= maximum) return normalized
  return `${normalized.slice(0, Math.max(0, maximum - 1))}…`
}

function finite(value, fallback = null) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeAction(order, index) {
  const action = String(order?.action || 'watch')
  return {
    priority: finite(order?.priority, index + 1),
    action,
    actionLabel: ACTION_LABELS[action] || action,
    code: text(order?.code, 12),
    name: text(order?.name || order?.code, 40),
    concept: text(order?.concept, 40),
    lots: Math.max(0, Math.trunc(finite(order?.estimatedLots, 0))),
    amount: finite(order?.estimatedAmount),
    referencePrice: finite(order?.referencePrice),
    reason: text(order?.reason, 100),
  }
}

function normalizeRecommendation(item, index) {
  return {
    priority: finite(item?.priority, index + 1),
    code: text(item?.code, 12),
    name: text(item?.name || item?.code, 40),
    concept: text(item?.concept, 40),
    reason: text(item?.reason, 100),
  }
}

export function buildPortfolioAdviceBrief(analysis = {}) {
  const executionPlan = analysis?.executionPlan || {}
  const actions = (Array.isArray(executionPlan.orders)
    ? executionPlan.orders
    : [])
    .map(normalizeAction)
    .filter((item) => item.code && item.name)
    .sort((left, right) => left.priority - right.priority)
    .slice(0, 6)

  const recommendationMap = new Map()
  const recommendations = Array.isArray(analysis?.recommendations)
    ? analysis.recommendations
    : []
  recommendations.forEach((item, index) => {
    const normalized = normalizeRecommendation(item, index)
    if (normalized.code && normalized.name && normalized.reason) {
      recommendationMap.set(normalized.code, normalized)
    }
  })
  actions
    .filter((item) => item.action === 'buy' || item.action === 'add')
    .forEach((item) => {
      if (recommendationMap.has(item.code)) return
      recommendationMap.set(item.code, {
        priority: item.priority,
        code: item.code,
        name: item.name,
        concept: item.concept,
        reason: item.reason,
      })
    })

  return {
    conclusion: text(
      executionPlan.todayGoal
        || analysis?.headline
        || '当前暂无需要立即执行的调仓动作',
      120,
    ),
    logic: text(
      analysis?.headline
        || analysis?.positionAssessment?.rationale
        || '以仓位、集中度、市场强弱和个股量化结果为依据。',
      100,
    ),
    projectedPositionPct: finite(
      executionPlan.projectedPositionPct
        ?? executionPlan.targetPositionPct
        ?? analysis?.allocation?.targetPositionPct,
    ),
    actions,
    recommendations: [...recommendationMap.values()]
      .sort((left, right) => left.priority - right.priority)
      .slice(0, 4),
    noRecommendationText: '本次不新增股票',
  }
}
