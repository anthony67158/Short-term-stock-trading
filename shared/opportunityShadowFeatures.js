export const OPPORTUNITY_SHADOW_FEATURE_NAMES = Object.freeze([
  'ret2dPct',
  'ret5dPct',
  'openGapPct',
  'intradayRangePct',
  'distanceToHighPct',
  'vwapDistancePct',
  'atrPct',
  'mainNetYi',
  'retailNetYi',
  'flowDivergence',
  'sectorRelativeStrength',
  'sectorRankPct',
  'limitUpDistancePct',
  'limitHitCount5d',
  'failedLimitCount5d',
  'orderImbalanceShort',
  'overheatReversalRisk',
  'liquidityComposite',
  'evidenceCompleteness',
  'signalOrderFlowContinuation',
  'signalOverheatRisk',
  'signalLiquidityConfirmed',
  'signalSectorRelativeStrength',
  'signalLimitCrowding',
])

function finite(value) {
  if (value == null || value === '' || value === '-') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function rounded(value, digits = 4) {
  const number = finite(value)
  return number == null ? 0 : +number.toFixed(digits)
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function pct(value, base) {
  const number = finite(value)
  const denominator = finite(base)
  return number != null && denominator > 0
    ? (number / denominator - 1) * 100
    : 0
}

function normalizedCandles(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => ({
      open: finite(item?.open),
      high: finite(item?.high),
      low: finite(item?.low),
      close: finite(item?.close),
    }))
    .filter((item) => (
      item.open > 0
      && item.high > 0
      && item.low > 0
      && item.close > 0
    ))
}

function atr14(candles) {
  if (candles.length < 15) return 0
  const values = candles.slice(-14).map((bar, index) => {
    const previous = candles[candles.length - 15 + index]
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previous.close),
      Math.abs(bar.low - previous.close),
    )
  })
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function limitStats(candles) {
  let hits = 0
  let failed = 0
  const recent = candles.slice(-5)
  for (let index = 0; index < recent.length; index += 1) {
    const absoluteIndex = candles.length - recent.length + index
    const previous = candles[absoluteIndex - 1]
    const bar = recent[index]
    if (!previous?.close) continue
    const threshold = previous.close * 1.095
    if (bar.high < threshold) continue
    hits += 1
    if (bar.close < previous.close * 1.09) failed += 1
  }
  return { hits, failed }
}

function minuteStructure(trends) {
  const recent = (Array.isArray(trends) ? trends : [])
    .slice(-6)
    .map((item) => ({
      price: finite(item?.price),
      average: finite(item?.avg ?? item?.vwap),
    }))
    .filter((item) => item.price > 0)
  if (!recent.length) {
    return {
      vwap: null,
      slopePct: 0,
      aboveVwapRatio: 0,
    }
  }
  const first = recent[0].price
  const last = recent.at(-1)
  return {
    vwap: last.average,
    slopePct: pct(last.price, first),
    aboveVwapRatio: recent.filter((item) =>
      item.average > 0 && item.price >= item.average
    ).length / recent.length,
  }
}

export function buildOpportunityShadowFeatures({
  quote = {},
  candles = [],
  trends = [],
  fund = {},
  sectorOpportunity = {},
} = {}) {
  const daily = normalizedCandles(candles)
  const current = finite(quote.price) ?? daily.at(-1)?.close
  const previousClose = finite(quote.preClose ?? quote.prevClose)
    ?? daily.at(-2)?.close
  const minute = minuteStructure(trends)
  const atr = atr14(daily)
  const mainNetYi = finite(fund.mainNetYi) ?? 0
  const retailNetYi = finite(fund.retailNetYi) ?? 0
  const mainRatio = finite(quote.mainRatio) ?? 0
  const sector = sectorOpportunity?.sector || sectorOpportunity || {}
  const sectorPct = finite(
    sector.pct
    ?? sector.changePct
    ?? sector.realtime?.pct,
  ) ?? 0
  const sectorRank = finite(
    sector.layoutRank
    ?? sector.rank
    ?? sector.nextRank,
  )
  const amount = Math.max(0, finite(quote.amount) ?? 0)
  const turnover = Math.max(0, finite(quote.turnover) ?? 0)
  const volumeRatio = Math.max(0, finite(quote.volumeRatio) ?? 0)
  const quotePct = finite(quote.pct) ?? pct(current, previousClose)
  const vwapDistancePct = pct(current, minute.vwap)
  const limitUpDistancePct = pct(
    finite(quote.limitUpPrice),
    current,
  )
  const limits = limitStats(daily)
  const flowDivergence = mainNetYi > 0 && retailNetYi < 0
    ? 1
    : mainNetYi < 0 && retailNetYi > 0
      ? -1
      : 0
  const orderImbalanceShort = clamp(
    mainRatio * 2
    + minute.slopePct * 8
    + (minute.aboveVwapRatio - 0.5) * 40,
    -100,
    100,
  )
  const overheatReversalRisk = clamp(
    Math.max(0, quotePct - 3) * 12
    + Math.max(0, turnover - 8) * 3
    + Math.max(0, vwapDistancePct - 2) * 8
    + Math.max(0, volumeRatio - 2.5) * 6
    + (limitUpDistancePct > 0 && limitUpDistancePct < 2 ? 15 : 0),
    0,
    100,
  )
  const liquidityComposite = clamp(
    Math.log10(Math.max(1, amount)) * 8
    + Math.min(turnover, 12) * 2
    + Math.min(volumeRatio, 4) * 4
    - 48,
    0,
    100,
  )
  const sectorRelativeStrength = quotePct - sectorPct
  const evidenceCompleteness = [
    daily.length >= 20,
    minute.vwap != null,
    finite(fund.mainNetYi) != null,
    finite(fund.retailNetYi) != null,
    !!(sector.code || sector.name),
  ].filter(Boolean).length / 5
  const raw = {
    ret2dPct: daily.length >= 3 ? pct(current, daily.at(-3).close) : 0,
    ret5dPct: daily.length >= 6 ? pct(current, daily.at(-6).close) : 0,
    openGapPct: pct(quote.open, previousClose),
    intradayRangePct: previousClose > 0
      ? ((finite(quote.high) ?? current) - (finite(quote.low) ?? current))
        / previousClose * 100
      : 0,
    distanceToHighPct: pct(current, quote.high),
    vwapDistancePct,
    atrPct: current > 0 ? atr / current * 100 : 0,
    mainNetYi,
    retailNetYi,
    flowDivergence,
    sectorRelativeStrength,
    sectorRankPct: sectorRank == null
      ? 0
      : clamp(1 - (sectorRank - 1) / 20, 0, 1),
    limitUpDistancePct,
    limitHitCount5d: limits.hits,
    failedLimitCount5d: limits.failed,
    orderImbalanceShort,
    overheatReversalRisk,
    liquidityComposite,
    evidenceCompleteness,
    signalOrderFlowContinuation:
      orderImbalanceShort >= 30
      && liquidityComposite >= 40
      && overheatReversalRisk < 65 ? 1 : 0,
    signalOverheatRisk: overheatReversalRisk >= 65 ? 1 : 0,
    signalLiquidityConfirmed: liquidityComposite >= 40 ? 1 : 0,
    signalSectorRelativeStrength:
      sectorRelativeStrength >= 0.8 && sectorRank != null ? 1 : 0,
    signalLimitCrowding:
      limits.hits >= 2
      || (limitUpDistancePct > 0 && limitUpDistancePct < 2) ? 1 : 0,
  }
  return Object.fromEntries(
    OPPORTUNITY_SHADOW_FEATURE_NAMES.map((name) => [
      name,
      rounded(raw[name], 6),
    ]),
  )
}
