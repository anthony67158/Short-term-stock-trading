function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rounded(value, digits = 2) {
  return Number.isFinite(Number(value))
    ? +Number(value).toFixed(digits)
    : null
}

function adverseBps(side, actual, reference) {
  if (!(actual > 0) || !(reference > 0)) return null
  const direction = side === 'SELL' ? -1 : 1
  return rounded((actual / reference - 1) * 10000 * direction)
}

export function attributeExecution(plan, {
  fills = [],
  vwap = null,
  netPnl = null,
  validationComplete = false,
} = {}) {
  if (plan?.schemaVersion !== 'execution-plan.v1') {
    throw new Error('归因只接受execution-plan.v1')
  }
  const realFills = (fills || []).filter(
    (fill) =>
      fill?.manuallyRecorded === true
      && finite(fill.lots) > 0
      && finite(fill.price) > 0,
  )
  const filledLots = realFills.reduce(
    (sum, fill) => sum + Number(fill.lots),
    0,
  )
  const shares = realFills.reduce(
    (sum, fill) => sum + Number(fill.lots) * 100,
    0,
  )
  const weightedAmount = realFills.reduce(
    (sum, fill) =>
      sum + Number(fill.price) * Number(fill.lots) * 100,
    0,
  )
  const averageFillPrice = shares > 0
    ? weightedAmount / shares
    : null
  const totalFees = realFills.reduce(
    (sum, fill) => sum + Math.max(0, finite(fill.fee) || 0),
    0,
  )
  const targetLots = Math.max(0, finite(plan.targetLots) || 0)
  const latestAt = realFills.reduce(
    (latest, fill) => Math.max(latest, finite(fill.at) || 0),
    0,
  )
  const status = !filledLots
    ? 'NOT_EXECUTED'
    : filledLots < targetLots
      ? 'PARTIAL'
      : filledLots === targetLots ? 'COMPLETED' : 'UNPLANNED'
  const resolvedVwap = finite(vwap)
    ?? finite(realFills.at(-1)?.vwap)
  return {
    schemaVersion: 'execution-attribution.v1',
    planId: String(plan.planId || ''),
    decisionId: String(plan.decisionId || ''),
    marketRegime: String(plan.marketRegime || ''),
    code: String(plan.code || ''),
    action: String(plan.action || ''),
    executionMethod: String(plan.executionMethod?.type || ''),
    side: plan.side,
    status,
    targetLots,
    filledLots,
    fillRatePct: targetLots > 0
      ? rounded(filledLots / targetLots * 100)
      : 0,
    averageFillPrice: rounded(averageFillPrice),
    decisionSlippageBps: adverseBps(
      plan.side,
      averageFillPrice,
      finite(plan.referencePrice),
    ),
    executionSlippageBps: adverseBps(
      plan.side,
      averageFillPrice,
      finite(plan.triggerPrice),
    ),
    vwapDeviationBps: adverseBps(
      plan.side,
      averageFillPrice,
      resolvedVwap,
    ),
    totalFees: rounded(totalFees),
    grossAmount: rounded(weightedAmount),
    recordDelayMs: latestAt > 0
      ? Math.max(0, latestAt - (finite(plan.createdAt) || latestAt))
      : null,
    netPnl: finite(netPnl),
    validationComplete: validationComplete === true,
    learningEligible: (
      status === 'COMPLETED'
      && validationComplete === true
      && finite(netPnl) != null
    ),
  }
}

export function aggregateExecutionAttribution(records = []) {
  const valid = (records || []).filter(
    (record) => record && typeof record === 'object',
  )
  const eligible = valid.filter(
    (record) =>
      record.status === 'COMPLETED'
      && record.validationComplete === true
      && finite(record.netPnl) != null,
  )
  const groups = new Map()
  for (const record of eligible) {
    const key = [
      record.marketRegime || 'UNKNOWN',
      record.action || 'UNKNOWN',
      record.code || 'unknown',
      record.executionMethod || 'UNKNOWN',
    ].join(':')
    const current = groups.get(key) || {
      key,
      marketRegime: record.marketRegime || 'UNKNOWN',
      action: record.action || 'UNKNOWN',
      code: record.code || 'unknown',
      executionMethod: record.executionMethod || 'UNKNOWN',
      samples: 0,
      netPnl: 0,
      totalFees: 0,
    }
    current.samples++
    current.netPnl += Number(record.netPnl)
    current.totalFees += Math.max(0, finite(record.totalFees) || 0)
    groups.set(key, current)
  }
  return {
    schemaVersion: 'execution-attribution-summary.v1',
    total: valid.length,
    learningEligible: eligible.length,
    groups: [...groups.values()].map((group) => ({
      ...group,
      netPnl: rounded(group.netPnl),
      totalFees: rounded(group.totalFees),
    })),
  }
}
