function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rounded(value, digits = 2) {
  if (value == null || value === '') return null
  return Number.isFinite(Number(value))
    ? +Number(value).toFixed(digits)
    : null
}

function adverseBps(side, actual, reference) {
  if (!(actual > 0) || !(reference > 0)) return null
  const direction = side === 'SELL' ? -1 : 1
  return rounded((actual / reference - 1) * 10000 * direction)
}

function pathExtremes(pricePath = []) {
  const highs = []
  const lows = []
  for (const point of Array.isArray(pricePath) ? pricePath : []) {
    if (typeof point === 'number') {
      if (point > 0) {
        highs.push(point)
        lows.push(point)
      }
      continue
    }
    const high = finite(point?.high ?? point?.price ?? point?.close)
    const low = finite(point?.low ?? point?.price ?? point?.close)
    if (high > 0) highs.push(high)
    if (low > 0) lows.push(low)
  }
  return {
    peakPrice: highs.length ? Math.max(...highs) : null,
    troughPrice: lows.length ? Math.min(...lows) : null,
  }
}

function excursionMetrics({
  side,
  entryPrice,
  averageFillPrice,
  entryAt,
  exitAt,
  pricePath,
  peakPrice,
  troughPrice,
}) {
  const entry = finite(entryPrice)
  const exit = finite(averageFillPrice)
  const openedAt = finite(entryAt)
  const closedAt = finite(exitAt)
  const path = pathExtremes(pricePath)
  const peak = finite(peakPrice) ?? path.peakPrice
  const trough = finite(troughPrice) ?? path.troughPrice
  const holdingDurationMs = openedAt != null && closedAt != null
    ? Math.max(0, closedAt - openedAt)
    : null
  if (side !== 'SELL' || !(entry > 0)) {
    return {
      entryPrice: entry,
      entryAt: openedAt,
      exitAt: closedAt,
      holdingDurationMs,
      holdingDurationMinutes: holdingDurationMs == null
        ? null
        : rounded(holdingDurationMs / 60000, 1),
      mfePct: null,
      maePct: null,
      profitCapturePct: null,
    }
  }
  const mfePct = peak != null
    ? Math.max(0, (peak / entry - 1) * 100)
    : null
  const maePct = trough != null
    ? Math.min(0, (trough / entry - 1) * 100)
    : null
  const realizedGainPct = exit != null
    ? (exit / entry - 1) * 100
    : null
  const profitCapturePct = (
    mfePct != null
    && mfePct > 0
    && realizedGainPct != null
    && realizedGainPct > 0
  )
    ? Math.max(0, Math.min(100, realizedGainPct / mfePct * 100))
    : null
  return {
    entryPrice: rounded(entry, 4),
    entryAt: openedAt,
    exitAt: closedAt,
    holdingDurationMs,
    holdingDurationMinutes: holdingDurationMs == null
      ? null
      : rounded(holdingDurationMs / 60000, 1),
    mfePct: rounded(mfePct),
    maePct: rounded(maePct),
    profitCapturePct: rounded(profitCapturePct, 1),
  }
}

export function attributeExecution(plan, {
  fills = [],
  vwap = null,
  netPnl = null,
  validationComplete = false,
  entryPrice = null,
  entryAt = null,
  exitAt = null,
  pricePath = [],
  peakPrice = null,
  troughPrice = null,
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
  const outcomeMetrics = excursionMetrics({
    side: plan.side,
    entryPrice,
    averageFillPrice,
    entryAt,
    exitAt: finite(exitAt) ?? latestAt,
    pricePath,
    peakPrice,
    troughPrice,
  })
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
    transactionIds: realFills
      .map((fill) => String(fill.transactionId || fill.fillId || ''))
      .filter(Boolean),
    recordDelayMs: latestAt > 0
      ? Math.max(0, latestAt - (finite(plan.createdAt) || latestAt))
      : null,
    netPnl: finite(netPnl),
    ...outcomeMetrics,
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
      holdingDurationMinutes: [],
      mfePct: [],
      maePct: [],
      profitCapturePct: [],
    }
    current.samples++
    current.netPnl += Number(record.netPnl)
    current.totalFees += Math.max(0, finite(record.totalFees) || 0)
    for (const field of [
      'holdingDurationMinutes',
      'mfePct',
      'maePct',
      'profitCapturePct',
    ]) {
      const value = finite(record[field])
      if (value != null) current[field].push(value)
    }
    groups.set(key, current)
  }
  return {
    schemaVersion: 'execution-attribution-summary.v1',
    total: valid.length,
    learningEligible: eligible.length,
    groups: [...groups.values()].map((group) => {
      const {
        holdingDurationMinutes,
        mfePct,
        maePct,
        profitCapturePct,
        ...summary
      } = group
      return {
        ...summary,
        netPnl: rounded(summary.netPnl),
        totalFees: rounded(summary.totalFees),
        averageHoldingMinutes: holdingDurationMinutes.length
          ? rounded(
              holdingDurationMinutes.reduce(
                (sum, value) => sum + value,
                0,
              ) / holdingDurationMinutes.length,
              1,
            )
          : null,
        averageMfePct: mfePct.length
          ? rounded(
              mfePct.reduce((sum, value) => sum + value, 0)
                / mfePct.length,
            )
          : null,
        averageMaePct: maePct.length
          ? rounded(
              maePct.reduce((sum, value) => sum + value, 0)
                / maePct.length,
            )
          : null,
        averageProfitCapturePct: profitCapturePct.length
          ? rounded(
              profitCapturePct.reduce(
                (sum, value) => sum + value,
                0,
              ) / profitCapturePct.length,
              1,
            )
          : null,
      }
    }),
  }
}
