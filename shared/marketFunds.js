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

function uniqueSectorFlows(sectors) {
  const rows = Array.isArray(sectors?.list)
    ? sectors.list
    : Array.isArray(sectors) ? sectors : []
  const seen = new Set()
  const result = []
  for (const row of rows) {
    const key = String(row?.code || row?.name || '').trim()
    const mainInflow = finite(row?.mainInflow)
    if (!key || mainInflow == null || seen.has(key)) continue
    seen.add(key)
    result.push({
      code: String(row?.code || ''),
      name: String(row?.name || ''),
      mainInflow,
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
  sectors = null,
  market = null,
  updatedAt = Date.now(),
} = {}) {
  const rows = uniqueSectorFlows(sectors)
  const inflows = rows
    .filter((row) => row.mainInflow > 0)
    .sort((left, right) => right.mainInflow - left.mainInflow)
  const outflows = rows.filter((row) => row.mainInflow < 0)
  const flatSectorCount = rows.filter(
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
  const mainNet = rows.length
    ? inflowTotal - outflowTotal
    : null
  const top3Inflow = inflows.slice(0, 3).reduce(
    (sum, row) => sum + row.mainInflow,
    0,
  )
  const turnover = turnoverSnapshot(market?.breadth)
  const hasTurnover = turnover.amountYi != null

  return {
    schemaVersion: MARKET_FUNDS_SCHEMA_VERSION,
    source: 'eastmoney-industry-aggregate',
    status: rows.length
      ? 'READY'
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
    netStrengthPct: grossFlow > 0
      ? round(mainNet / grossFlow * 100, 1)
      : rows.length ? 0 : null,
    inflowSectorCount: rows.length ? inflows.length : null,
    outflowSectorCount: rows.length ? outflows.length : null,
    flatSectorCount: rows.length ? flatSectorCount : null,
    sectorCount: rows.length || null,
    inflowBreadthPct: rows.length
      ? round(inflows.length / rows.length * 100, 1)
      : null,
    top3InflowSharePct: inflowTotal > 0
      ? round(top3Inflow / inflowTotal * 100, 1)
      : null,
    turnover,
  }
}
