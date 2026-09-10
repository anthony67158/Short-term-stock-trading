export const MARKET_FUNDS_SCHEMA_VERSION = 'market-funds.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

const PRIMARY_MARKETS = new Map([
  ['000001', '沪市'],
  ['399001', '深市'],
  ['899050', '北证'],
])

function primaryMarketFlows(market) {
  const rows = Array.isArray(market?.indices)
    ? market.indices
    : []
  const seen = new Set()
  const result = []
  for (const row of rows) {
    const code = String(row?.code || '')
    const mainInflow = finite(row?.mainInflow)
    if (
      !PRIMARY_MARKETS.has(code)
      || mainInflow == null
      || seen.has(code)
    ) continue
    seen.add(code)
    result.push({
      code,
      name: String(row?.name || PRIMARY_MARKETS.get(code)),
      label: PRIMARY_MARKETS.get(code),
      mainInflow,
      amount: finite(row?.amount),
      pct: finite(row?.pct),
    })
  }
  return result
}

function turnoverSnapshot(breadth = {}) {
  const amountYi = finite(breadth.amountYi)
  const deltaPct = breadth.volumeComparable === true
    ? finite(breadth.volVsAvg5)
    : null
  const directAverage5Yi = breadth.volumeComparable === true
    ? finite(breadth.avg5AmountYi)
    : null
  const directDeltaYi = breadth.volumeComparable === true
    ? finite(breadth.amountDeltaVsAvg5Yi)
    : null
  const ratio = deltaPct == null ? null : 1 + deltaPct / 100
  const derivedAverage5Yi = (
    amountYi != null
    && ratio != null
    && ratio > 0
  ) ? amountYi / ratio : null
  const average5Yi = directAverage5Yi ?? derivedAverage5Yi
  const deltaYi = directDeltaYi ?? (average5Yi == null
    ? null
    : amountYi - average5Yi)
  return {
    amountYi: round(amountYi, 2),
    average5Yi: round(average5Yi, 2),
    deltaYi: round(deltaYi, 2),
    deltaPct: round(deltaPct, 1),
    comparable: deltaPct != null,
    direction: deltaYi == null
      ? 'UNAVAILABLE'
      : deltaYi > 0 ? 'EXPANDING'
        : deltaYi < 0 ? 'CONTRACTING' : 'FLAT',
  }
}

export function buildMarketFundsSnapshot({
  market = null,
  updatedAt = Date.now(),
} = {}) {
  const rows = primaryMarketFlows(market)
  const inflows = rows
    .filter((row) => row.mainInflow > 0)
    .sort((left, right) => right.mainInflow - left.mainInflow)
  const outflows = rows.filter((row) => row.mainInflow < 0)
  const flatMarketCount = rows.filter(
    (row) => row.mainInflow === 0,
  ).length
  const inflowTotal = inflows.reduce(
    (sum, row) => sum + row.mainInflow,
    0,
  )
  const outflowTotal = Math.abs(outflows.reduce(
    (sum, row) => sum + row.mainInflow,
    0,
  ))
  const grossFlow = inflowTotal + outflowTotal
  const totalAmount = rows.reduce(
    (sum, row) => sum + Math.max(0, row.amount || 0),
    0,
  )
  const mainNet = rows.length
    ? inflowTotal - outflowTotal
    : null
  const dominant = rows.slice().sort(
    (left, right) =>
      Math.abs(right.mainInflow) - Math.abs(left.mainInflow),
  )[0] || null
  const indexMoves = rows
    .map((row) => row.pct)
    .filter((value) => value != null)
  const averageIndexPct = indexMoves.length
    ? indexMoves.reduce((sum, value) => sum + value, 0)
      / indexMoves.length
    : null
  const turnover = turnoverSnapshot(market?.breadth)
  const hasTurnover = turnover.amountYi != null
  const resonance = mainNet == null || averageIndexPct == null
    ? 'UNKNOWN'
    : mainNet > 0 && averageIndexPct > 0
      ? 'POSITIVE'
      : mainNet < 0 && averageIndexPct < 0
        ? 'NEGATIVE'
        : mainNet === 0 || averageIndexPct === 0
          ? 'NEUTRAL' : 'DIVERGENT'

  return {
    schemaVersion: MARKET_FUNDS_SCHEMA_VERSION,
    source: 'eastmoney-primary-index-aggregate',
    status: rows.length === PRIMARY_MARKETS.size
      ? 'READY'
      : rows.length
        ? 'PARTIAL'
      : hasTurnover ? 'PARTIAL' : 'MISSING',
    asOf: Number(updatedAt) || Date.now(),
    mainNetYi: mainNet == null
      ? null
      : round(mainNet / 1e8, 2),
    inflowTotalYi: rows.length
      ? round(inflowTotal / 1e8, 2)
      : null,
    outflowTotalYi: rows.length
      ? round(outflowTotal / 1e8, 2)
      : null,
    direction: mainNet == null
      ? 'UNKNOWN'
      : mainNet > 0 ? 'INFLOW'
        : mainNet < 0 ? 'OUTFLOW' : 'FLAT',
    netStrengthPct: totalAmount > 0
      ? round(mainNet / totalAmount * 100, 2)
      : grossFlow > 0
        ? round(mainNet / grossFlow * 100, 2)
        : rows.length ? 0 : null,
    inflowMarketCount: rows.length ? inflows.length : null,
    outflowMarketCount: rows.length ? outflows.length : null,
    flatMarketCount: rows.length ? flatMarketCount : null,
    marketCount: rows.length || null,
    averageIndexPct: round(averageIndexPct, 2),
    resonance,
    dominantMarket: dominant ? {
      code: dominant.code,
      name: dominant.name,
      label: dominant.label,
      mainNetYi: round(dominant.mainInflow / 1e8, 2),
      direction: dominant.mainInflow > 0
        ? 'INFLOW'
        : dominant.mainInflow < 0 ? 'OUTFLOW' : 'FLAT',
    } : null,
    turnover,
  }
}
