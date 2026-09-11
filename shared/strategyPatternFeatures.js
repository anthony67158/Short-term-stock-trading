export const STRATEGY_PATTERN_VERSION = 'strategy-pattern-features.v1'

export const STRATEGY_PATTERN_FEATURE_NAMES = Object.freeze([
  'patternHistoryCoverage',
  'patternPlatformRange10Pct',
  'patternBreakoutDistance10Pct',
  'patternMa20DistancePct',
  'patternMa60DistancePct',
  'patternDailyVolumeRatio5',
  'patternMomentum20Pct',
  'patternMa20CrossUp',
  'patternLowerShadowPct',
  'patternCloseLocationPct',
  'patternAnnualVol20Pct',
  'patternPlatformBreakoutScore',
  'patternSupportPullbackScore',
  'patternVolumePriceSurgeScore',
  'patternLowerShadowReversalScore',
  'patternLowVolTrendScore',
])

const PATTERN_DEFINITIONS = Object.freeze([
  {
    id: 'PLATFORM_BREAKOUT',
    label: '平台整理突破',
    score: 'patternPlatformBreakoutScore',
    playbooks: ['MOMENTUM_BREAKOUT'],
    routes: ['BREAKOUT', 'IMMEDIATE'],
  },
  {
    id: 'SUPPORT_PULLBACK',
    label: '缩量回踩',
    score: 'patternSupportPullbackScore',
    playbooks: ['LEADER_PULLBACK', 'RANGE_REVERSION'],
    routes: ['PULLBACK'],
  },
  {
    id: 'VOLUME_PRICE_SURGE',
    label: '量价齐升',
    score: 'patternVolumePriceSurgeScore',
    playbooks: ['MOMENTUM_BREAKOUT', 'ACCUMULATION'],
    routes: ['IMMEDIATE', 'BREAKOUT'],
  },
  {
    id: 'LOWER_SHADOW_REVERSAL',
    label: '长下影反击',
    score: 'patternLowerShadowReversalScore',
    playbooks: ['PANIC_REVERSAL'],
    routes: ['IMMEDIATE', 'PULLBACK'],
  },
  {
    id: 'LOW_VOL_TREND',
    label: '低波动趋势',
    score: 'patternLowVolTrendScore',
    playbooks: ['LEADER_PULLBACK', 'RANGE_REVERSION'],
    routes: ['PULLBACK', 'BREAKOUT'],
  },
])

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, value))
}

function rounded(value, digits = 6) {
  const number = finite(value)
  return number == null ? 0 : +number.toFixed(digits)
}

function ascendingScore(value, floor, target) {
  const number = finite(value)
  if (number == null || target <= floor) return 0
  return clamp((number - floor) / (target - floor) * 100)
}

function descendingScore(value, target, ceiling) {
  const number = finite(value)
  if (number == null || ceiling <= target) return 0
  return clamp((ceiling - number) / (ceiling - target) * 100)
}

function proximityScore(value, center, width) {
  const number = finite(value)
  if (number == null || width <= 0) return 0
  return clamp(100 - Math.abs(number - center) / width * 100)
}

function average(values) {
  const valid = values.filter((value) => finite(value) != null)
  return valid.length
    ? valid.reduce((sum, value) => sum + Number(value), 0) / valid.length
    : null
}

function standardDeviation(values) {
  const valid = values.filter((value) => finite(value) != null)
  if (valid.length < 2) return null
  const mean = average(valid)
  const variance = valid.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  ) / (valid.length - 1)
  return Math.sqrt(variance)
}

function normalizeBar(value = {}) {
  if (!value || typeof value !== 'object') return null
  const open = finite(value.open)
  const high = finite(value.high)
  const low = finite(value.low)
  const close = finite(value.close ?? value.price)
  if (
    !(open > 0)
    || !(high > 0)
    || !(low > 0)
    || !(close > 0)
    || high < Math.max(open, close)
    || low > Math.min(open, close)
  ) return null
  return {
    date: dayKey(value.date || value.tradeDate),
    open,
    high,
    low,
    close,
    volume: finite(value.volume),
  }
}

function dayKey(value) {
  const match = String(value || '').match(/^(\d{4})-?(\d{2})-?(\d{2})(?:$|[ T])/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : ''
}

function normalizedBars(candles, quote) {
  const cutoff = dayKey(quote?.tradeDate)
  const source = (Array.isArray(candles) ? candles : [])
    .map(normalizeBar)
    .filter(Boolean)
    .filter((bar) => !cutoff || !bar.date || bar.date <= cutoff)
  const bars = [...new Map(source.map((bar, i) => [bar.date || i, bar])).values()]
    .sort((left, right) => left.date.localeCompare(right.date))
  const current = normalizeBar({
    date: quote?.tradeDate,
    open: quote?.open,
    high: quote?.high,
    low: quote?.low,
    close: quote?.price ?? quote?.close,
    volume: quote?.volume,
  })
  if (!current || !current.date) return bars
  const last = bars.at(-1)
  if (last?.date && current.date && last.date === current.date) {
    return [...bars.slice(0, -1), current]
  }
  return [...bars, current]
}

function sma(values, period, offset = 0) {
  const end = values.length - offset
  const start = end - period
  if (start < 0 || end <= start) return null
  return average(values.slice(start, end))
}

function platformMetrics(bars, current) {
  const prior = bars.slice(-11, -1)
  if (prior.length < 10) {
    return { rangePct: null, breakoutDistancePct: null }
  }
  const high = Math.max(...prior.map((bar) => bar.high))
  const low = Math.min(...prior.map((bar) => bar.low))
  return {
    rangePct: current.close > 0
      ? (high - low) / current.close * 100
      : null,
    breakoutDistancePct: high > 0
      ? (current.close / high - 1) * 100
      : null,
  }
}

function annualVolatility20(closes) {
  if (closes.length < 21) return null
  const recent = closes.slice(-21)
  const returns = recent.slice(1).map(
    (value, index) => value / recent[index] - 1,
  )
  const daily = standardDeviation(returns)
  return daily == null ? null : daily * Math.sqrt(252) * 100
}

function evidence(features) {
  const number = (value, suffix = '%') =>
    finite(value) == null ? '数据缺失' : `${Number(value).toFixed(1)}${suffix}`
  const volume = features.patternDailyVolumeRatio5 > 0
    ? `量能${number(features.patternDailyVolumeRatio5, '倍')}`
    : '量能数据缺失'
  return {
    PLATFORM_BREAKOUT: [
      `平台振幅${number(features.patternPlatformRange10Pct)}`,
      `距平台上沿${number(features.patternBreakoutDistance10Pct)}`,
      volume,
    ],
    SUPPORT_PULLBACK: [
      `距MA20 ${number(features.patternMa20DistancePct)}`,
      volume,
      `20日动量${number(features.patternMomentum20Pct)}`,
    ],
    VOLUME_PRICE_SURGE: [
      features.patternMa20CrossUp >= 1 ? '本时点上穿MA20' : '尚未上穿MA20',
      volume,
    ],
    LOWER_SHADOW_REVERSAL: [
      `下影${number(features.patternLowerShadowPct)}`,
      `收盘位于日内${number(features.patternCloseLocationPct)}`,
      `5日涨跌${number(features.ret5dPct)}`,
    ],
    LOW_VOL_TREND: [
      `20日动量${number(features.patternMomentum20Pct)}`,
      `20日年化波动${number(features.patternAnnualVol20Pct)}`,
      `距MA20 ${number(features.patternMa20DistancePct)}`,
    ],
  }
}

export function buildStrategyPatternAnalysis({
  candles = [],
  quote = {},
  mode = 'intraday',
} = {}) {
  const bars = normalizedBars(candles, quote)
  const current = bars.at(-1)
  const closes = bars.map((bar) => bar.close)
  const volumes = bars.map((bar) => bar.volume)
  const previousClose = bars.at(-2)?.close
  const ma20 = sma(closes, 20)
  const previousMa20 = sma(closes, 20, 1)
  const ma60 = sma(closes, 60)
  const momentum20Pct = bars.length >= 21
    ? (current.close / bars.at(-21).close - 1) * 100
    : null
  const momentum5Pct = bars.length >= 6
    ? (current.close / bars.at(-6).close - 1) * 100
    : null
  const platform = current
    ? platformMetrics(bars, current)
    : { rangePct: null, breakoutDistancePct: null }
  const priorVolumes = volumes.slice(-6, -1)
  const priorVolume5 = priorVolumes.length === 5
    && priorVolumes.every((value) => value > 0) ? average(priorVolumes) : null
  const closeVolumeRatio = current?.volume != null && priorVolume5 > 0
    ? current.volume / priorVolume5
    : null
  const volumeRatio = String(mode).toLowerCase() === 'close'
    ? closeVolumeRatio
    : finite(quote?.volumeRatio ?? quote?.volRatio)
  const lowerShadowPct = current && previousClose > 0
    ? (Math.min(current.open, current.close) - current.low)
      / previousClose * 100
    : null
  const closeLocationPct = current && current.high > current.low
    ? (current.close - current.low) / (current.high - current.low) * 100
    : null
  const ma20DistancePct = current && ma20 > 0
    ? (current.close / ma20 - 1) * 100
    : null
  const ma60DistancePct = current && ma60 > 0
    ? (current.close / ma60 - 1) * 100
    : null
  const ma20CrossUp = current && previousClose > 0 && ma20 > 0
    && previousMa20 > 0
    && current.close > ma20
    && previousClose <= previousMa20
  const annualVol20Pct = annualVolatility20(closes)

  const compression = descendingScore(platform.rangePct, 4, 12)
  const breakout = ascendingScore(platform.breakoutDistancePct, -1, 1)
  const expandedVolume = ascendingScore(volumeRatio, 1, 2)
  const contractedVolume = descendingScore(volumeRatio, 0.6, 1.2)
  const ma20Proximity = proximityScore(ma20DistancePct, 0, 4)
  const aboveMa60 = ascendingScore(ma60DistancePct, -2, 4)
  const positiveMomentum = ascendingScore(momentum20Pct, 0, 8)
  const lowerShadow = ascendingScore(lowerShadowPct, 1, 4)
  const oversold = descendingScore(momentum5Pct, -5, 2)
  const recovered = ascendingScore(closeLocationPct, 35, 75)
  const lowVolatility = descendingScore(annualVol20Pct, 20, 45)
  const aboveMa20 = ascendingScore(ma20DistancePct, -1, 3)
  const bullishBody = current && current.close > current.open ? 100 : 0

  const raw = {
    patternHistoryCoverage: clamp(bars.length / 60, 0, 1),
    patternPlatformRange10Pct: platform.rangePct,
    patternBreakoutDistance10Pct: platform.breakoutDistancePct,
    patternMa20DistancePct: ma20DistancePct,
    patternMa60DistancePct: ma60DistancePct,
    patternDailyVolumeRatio5: volumeRatio,
    patternMomentum20Pct: momentum20Pct,
    patternMa20CrossUp: ma20CrossUp ? 1 : 0,
    patternLowerShadowPct: lowerShadowPct,
    patternCloseLocationPct: closeLocationPct,
    patternAnnualVol20Pct: annualVol20Pct,
    patternPlatformBreakoutScore:
      compression * 0.45 + breakout * 0.35 + expandedVolume * 0.2,
    patternSupportPullbackScore:
      ma20Proximity * 0.35 + contractedVolume * 0.25
      + aboveMa60 * 0.2 + positiveMomentum * 0.2,
    patternVolumePriceSurgeScore:
      (ma20CrossUp ? 100 : aboveMa20 * 0.35) * 0.4
      + expandedVolume * 0.35 + bullishBody * 0.25,
    patternLowerShadowReversalScore:
      lowerShadow * 0.35 + oversold * 0.25
      + recovered * 0.25 + expandedVolume * 0.15,
    patternLowVolTrendScore:
      positiveMomentum * 0.35 + lowVolatility * 0.35
      + aboveMa20 * 0.3,
  }
  const tradable = !!current && current.volume !== 0 && quote?.isSuspended !== true
  const availability = {
    patternPlatformBreakoutScore: tradable && bars.length >= 11 && volumeRatio > 0,
    patternSupportPullbackScore: tradable && bars.length >= 60 && volumeRatio > 0,
    patternVolumePriceSurgeScore: tradable && bars.length >= 21 && volumeRatio > 0,
    patternLowerShadowReversalScore: tradable && bars.length >= 6 && volumeRatio > 0,
    patternLowVolTrendScore: tradable && bars.length >= 21,
  }
  for (const [name, available] of Object.entries(availability)) {
    if (!available) raw[name] = 0
  }
  const features = Object.fromEntries(
    STRATEGY_PATTERN_FEATURE_NAMES.map((name) => [
      name,
      rounded(raw[name]),
    ]),
  )
  const summary = summarizeStrategyPatterns({
    ...features,
    ret5dPct: rounded(momentum5Pct),
  })
  return {
    schemaVersion: STRATEGY_PATTERN_VERSION,
    features,
    availability,
    ...summary,
  }
}

export function summarizeStrategyPatterns(features = {}) {
  const evidenceById = evidence(features)
  const patterns = PATTERN_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    score: rounded(features[definition.score], 1),
    matched: features[definition.score] >= 70,
    evidence: evidenceById[definition.id],
    playbooks: definition.playbooks,
    routes: definition.routes,
  })).sort((left, right) => right.score - left.score)
  return {
    patterns,
    strongest: patterns[0] || null,
  }
}

export function buildStrategyPatternFeatures(input = {}) {
  return buildStrategyPatternAnalysis(input).features
}
