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
  'fundCurrentAvailable',
  'fundHistoryAvailable',
  'fundHistoryDayCount',
  'fundHistoryComplete',
  'main5dYi',
  'retail5dYi',
  'mainInflowDays5',
  'retailInflowDays5',
  'mainStreak5',
  'retailStreak5',
  'mainTrendSlope5',
  'retailTrendSlope5',
  'flowDivergenceBalance5',
  'flowDivergence',
  'sectorRelativeStrength',
  'sectorRankPct',
  'sectorMainNetYi',
  'sectorBreadthPct',
  'sectorMemberCount',
  'sectorFlowRankPct',
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
  'dailyTechnicalAvailable',
  'intradayTechnicalAvailable',
  'sectorContextAvailable',
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

function fundTrend(values) {
  return (Array.isArray(values) ? values : [])
    .slice(-5)
    .map((value) => finite(value))
}

function trendSlope(values) {
  const points = values
    .map((value, index) => ({ index, value }))
    .filter((item) => item.value != null)
  if (points.length < 2) return 0
  const meanIndex = points.reduce(
    (sum, item) => sum + item.index,
    0,
  ) / points.length
  const meanValue = points.reduce(
    (sum, item) => sum + item.value,
    0,
  ) / points.length
  const denominator = points.reduce(
    (sum, item) => sum + (item.index - meanIndex) ** 2,
    0,
  )
  if (denominator <= 0) return 0
  return points.reduce(
    (sum, item) => (
      sum
      + (item.index - meanIndex) * (item.value - meanValue)
    ),
    0,
  ) / denominator
}

function signedStreak(values) {
  let result = 0
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (value == null || value === 0) break
    if (result === 0) result = value > 0 ? 1 : -1
    else if ((result > 0) === (value > 0)) result += result > 0 ? 1 : -1
    else break
  }
  return result
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
  const rawMainNetYi = finite(fund.mainNetYi)
  const rawRetailNetYi = finite(fund.retailNetYi)
  const mainNetYi = rawMainNetYi ?? 0
  const retailNetYi = rawRetailNetYi ?? 0
  const mainTrend5 = fundTrend(fund.mainTrend5 ?? fund.trend5)
  const retailTrend5 = fundTrend(fund.retailTrend5)
  const historyDayCount = clamp(
    finite(fund.historyDayCount)
      ?? Math.max(mainTrend5.length, retailTrend5.length),
    0,
    5,
  )
  const historyComplete = (
    historyDayCount >= 5
    && mainTrend5.filter((value) => value != null).length >= 5
    && retailTrend5.filter((value) => value != null).length >= 5
  )
  const fundCurrentAvailable = (
    rawMainNetYi != null && rawRetailNetYi != null
  )
  const fundHistoryAvailable = (
    historyDayCount > 0
    && (
      mainTrend5.some((value) => value != null)
      || retailTrend5.some((value) => value != null)
    )
  )
  const mainRatio = finite(quote.mainRatio) ?? 0
  const sector = sectorOpportunity?.sector || sectorOpportunity || {}
  const sectorContextAvailable = !!(
    sector.code
    || sector.name
    || finite(sector.pct ?? sector.changePct ?? sector.realtime?.pct) != null
  )
  const dailyTechnicalAvailable = daily.length >= 20
  const intradayTechnicalAvailable = minute.vwap != null
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
  const sectorMainNetYi = finite(
    sector.mainNetYi
    ?? sector.netAmount
    ?? sector.mainInflow,
  ) ?? 0
  const sectorBreadthPct = finite(
    sector.breadthPct
    ?? sector.breadth?.inflowPct
    ?? sector.breadth,
  ) ?? 0
  const sectorMemberCount = finite(
    sector.memberCount
    ?? sector.companyNum
    ?? sector.breadth?.total,
  ) ?? 0
  const sectorFlowRank = finite(
    sector.flowRank
    ?? sector.rank,
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
    dailyTechnicalAvailable,
    intradayTechnicalAvailable,
    fundCurrentAvailable,
    historyComplete,
    sectorContextAvailable,
  ].filter(Boolean).length / 5
  const flowDivergenceBalance5 = Array.from({
    length: Math.max(mainTrend5.length, retailTrend5.length),
  }).reduce((sum, _, index) => {
    const main = mainTrend5[index]
    const retail = retailTrend5[index]
    if (main > 0 && retail < 0) return sum + 1
    if (main < 0 && retail > 0) return sum - 1
    return sum
  }, 0)
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
    fundCurrentAvailable: fundCurrentAvailable ? 1 : 0,
    fundHistoryAvailable: fundHistoryAvailable ? 1 : 0,
    fundHistoryDayCount: historyDayCount,
    fundHistoryComplete: historyComplete ? 1 : 0,
    main5dYi: finite(fund.main5dYi)
      ?? (
        historyComplete
          ? mainTrend5.reduce((sum, value) => sum + value, 0)
          : 0
      ),
    retail5dYi: finite(fund.retail5dYi)
      ?? (
        historyComplete
          ? retailTrend5.reduce((sum, value) => sum + value, 0)
          : 0
      ),
    mainInflowDays5: finite(fund.inflowDays)
      ?? mainTrend5.filter((value) => value > 0).length,
    retailInflowDays5: finite(fund.retailInflowDays)
      ?? retailTrend5.filter((value) => value > 0).length,
    mainStreak5: finite(fund.mainStreak) ?? signedStreak(mainTrend5),
    retailStreak5:
      finite(fund.retailStreak) ?? signedStreak(retailTrend5),
    mainTrendSlope5: trendSlope(mainTrend5),
    retailTrendSlope5: trendSlope(retailTrend5),
    flowDivergenceBalance5,
    flowDivergence,
    sectorRelativeStrength,
    sectorRankPct: sectorRank == null
      ? 0
      : clamp(1 - (sectorRank - 1) / 20, 0, 1),
    sectorMainNetYi,
    sectorBreadthPct,
    sectorMemberCount,
    sectorFlowRankPct: sectorFlowRank == null
      ? 0
      : clamp(1 - (sectorFlowRank - 1) / 30, 0, 1),
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
    dailyTechnicalAvailable: dailyTechnicalAvailable ? 1 : 0,
    intradayTechnicalAvailable: intradayTechnicalAvailable ? 1 : 0,
    sectorContextAvailable: sectorContextAvailable ? 1 : 0,
  }
  return Object.fromEntries(
    OPPORTUNITY_SHADOW_FEATURE_NAMES.map((name) => [
      name,
      rounded(raw[name], 6),
    ]),
  )
}
