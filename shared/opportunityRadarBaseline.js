export const OPPORTUNITY_RADAR_BASELINE_SCHEMA_VERSION =
  'opportunity-radar-baseline.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rounded(value, digits = 3) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function mean(values) {
  if (!values.length) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function eligibleOutcomes(values) {
  const unique = new Map()
  for (const item of Array.isArray(values) ? values : []) {
    if (
      item?.maturity !== 'MATURED'
      || item?.outcome === 'NOT_ELIGIBLE'
    ) continue
    const key = String(item.decisionId || '')
    if (!key) continue
    unique.set(key, item)
  }
  return [...unique.values()]
}

function outcomeCounts(items) {
  return Object.fromEntries(
    [...items.reduce((counts, item) => {
      const key = String(item.outcome || 'UNKNOWN')
      counts.set(key, (counts.get(key) || 0) + 1)
      return counts
    }, new Map()).entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  )
}

function metrics(items) {
  const samples = items.length
  const triggered = items.filter((item) => (
    !['NOT_TRIGGERED', 'NOT_APPLICABLE', 'UNKNOWN']
      .includes(String(item.fillStatus || ''))
  )).length
  const filled = items.filter(
    (item) => item.fillStatus === 'FILLED',
  ).length
  const completed = items.filter((item) => (
    finite(item.metrics?.netR) != null
    && finite(item.metrics?.netPnl) != null
  ))
  const netRs = completed.map((item) => Number(item.metrics.netR))
  const netPnls = completed.map((item) => Number(item.metrics.netPnl))
  const netReturns = completed
    .map((item) => finite(item.metrics?.netReturnPct))
    .filter((value) => value != null)
  const mfes = completed
    .map((item) => finite(item.metrics?.mfePct))
    .filter((value) => value != null)
  const maes = completed
    .map((item) => finite(item.metrics?.maePct))
    .filter((value) => value != null)
  const wins = netPnls.filter((value) => value > 0).length
  const losses = netPnls.filter((value) => value < 0).length
  const grossProfitR = netRs
    .filter((value) => value > 0)
    .reduce((sum, value) => sum + value, 0)
  const grossLossR = Math.abs(netRs
    .filter((value) => value < 0)
    .reduce((sum, value) => sum + value, 0))
  const sortedNetRs = netRs.slice().sort((left, right) => left - right)
  const tailCount = sortedNetRs.length
    ? Math.max(1, Math.ceil(sortedNetRs.length * 0.1))
    : 0
  const expectedShortfall = tailCount
    ? mean(sortedNetRs.slice(0, tailCount))
    : null

  return {
    samples,
    triggered,
    filled,
    completedTrades: completed.length,
    wins,
    losses,
    triggerRatePct: samples
      ? rounded(triggered / samples * 100, 2)
      : null,
    fillRateGivenTriggerPct: triggered
      ? rounded(filled / triggered * 100, 2)
      : null,
    winRatePct: completed.length
      ? rounded(wins / completed.length * 100, 2)
      : null,
    expectedNetRGivenFill: rounded(mean(netRs)),
    expectedNetRPerCandidate: samples
      ? rounded(
          netRs.reduce((sum, value) => sum + value, 0) / samples,
        )
      : null,
    avgNetReturnPct: rounded(mean(netReturns)),
    profitFactorR: grossLossR > 0
      ? rounded(grossProfitR / grossLossR, 2)
      : null,
    profitFactorState: grossLossR > 0
      ? 'FINITE'
      : grossProfitR > 0 ? 'NO_LOSSES' : 'UNAVAILABLE',
    expectedShortfall10R: rounded(expectedShortfall),
    avgMfePct: rounded(mean(mfes)),
    avgMaePct: rounded(mean(maes)),
    totalNetPnl: rounded(
      netPnls.reduce((sum, value) => sum + value, 0),
      2,
    ),
    ambiguousPaths: items.filter(
      (item) => item.observations?.pathAmbiguous === true,
    ).length,
    blockedExitEvents: items.filter(
      (item) => Number(item.observations?.blockedExitAttempts) > 0,
    ).length,
    sampleSufficient: samples >= 30 && completed.length >= 20,
    outcomes: outcomeCounts(items),
  }
}

function groupKey(item, dimension) {
  if (dimension === 'formula') {
    return String(item.formulaId || 'UNKNOWN')
  }
  if (dimension === 'displayed') {
    return item.context?.displayed === true
      ? 'DISPLAYED'
      : 'NOT_DISPLAYED'
  }
  const field = dimension === 'liquidity'
    ? 'liquidityBucket'
    : dimension
  return String(item.context?.[field] || 'UNKNOWN')
}

function grouped(items, dimension) {
  const groups = new Map()
  for (const item of items) {
    const key = groupKey(item, dimension)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return [...groups.entries()]
    .map(([key, values]) => ({
      key,
      ...metrics(values),
    }))
    .sort((left, right) =>
      right.samples - left.samples
      || left.key.localeCompare(right.key),
    )
}

export function buildOpportunityRadarBaseline(
  outcomes,
  {
    generatedAt = Date.now(),
    from = null,
    to = null,
  } = {},
) {
  const timestamp = Number(generatedAt)
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error('机会雷达基线生成时间无效')
  }
  const items = eligibleOutcomes(outcomes)
  return {
    schemaVersion: OPPORTUNITY_RADAR_BASELINE_SCHEMA_VERSION,
    generatedAt: timestamp,
    range: {
      from: String(from || ''),
      to: String(to || ''),
    },
    overall: metrics(items),
    groups: {
      formula: grouped(items, 'formula'),
      marketState: grouped(items, 'marketState'),
      sectorPhase: grouped(items, 'sectorPhase'),
      timeBucket: grouped(items, 'timeBucket'),
      liquidity: grouped(items, 'liquidity'),
      displayed: grouped(items, 'displayed'),
    },
  }
}
