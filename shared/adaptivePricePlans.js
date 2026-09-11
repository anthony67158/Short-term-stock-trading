import {
  evaluateSelectionActionValue,
} from './selectionActionValue.js'
import {
  scoreOpportunityPlaybooks,
} from './opportunityPlaybooks.js'

export const ADAPTIVE_PRICE_PLAN_VERSION = 'adaptive-price-plan.v1'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function price(value) {
  const number = finite(value)
  return number != null && number > 0 ? +number.toFixed(2) : null
}

function normalizedCandles(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((item) => ({
      high: finite(item?.high),
      low: finite(item?.low),
      close: finite(item?.close),
    }))
    .filter((item) => item.high > 0 && item.low > 0 && item.close > 0)
}

function average(values = []) {
  const rows = values.filter((value) => finite(value) != null)
  return rows.length
    ? rows.reduce((sum, value) => sum + Number(value), 0) / rows.length
    : null
}

function atr14(rows = []) {
  if (rows.length < 2) return null
  const periods = rows.slice(-15)
  const ranges = periods.slice(1).map((bar, index) => {
    const previous = periods[index]
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previous.close),
      Math.abs(bar.low - previous.close),
    )
  })
  return average(ranges)
}

function legalPrice(value, quote = {}) {
  const candidate = price(value)
  const lower = price(quote.limitDownPrice)
  const upper = price(quote.limitUpPrice)
  if (candidate == null) return null
  if (lower != null && candidate < lower) return null
  if (upper != null && candidate > upper) return null
  return candidate
}

function tradingDaysFor(playbook) {
  return {
    MOMENTUM_BREAKOUT: 2,
    LEADER_PULLBACK: 4,
    ACCUMULATION: 5,
    CATALYST: 5,
    PANIC_REVERSAL: 2,
    RANGE_REVERSION: 3,
  }[playbook] || 3
}

function strongestPattern(shadow = {}) {
  return [
    ['PLATFORM_BREAKOUT', '平台整理突破', shadow.patternPlatformBreakoutScore],
    ['SUPPORT_PULLBACK', '缩量回踩', shadow.patternSupportPullbackScore],
    ['VOLUME_PRICE_SURGE', '量价齐升', shadow.patternVolumePriceSurgeScore],
    [
      'LOWER_SHADOW_REVERSAL',
      '长下影反击',
      shadow.patternLowerShadowReversalScore,
    ],
    ['LOW_VOL_TREND', '低波动趋势', shadow.patternLowVolTrendScore],
  ].map(([id, label, score]) => ({
    id,
    label,
    score: finite(score) ?? 0,
  })).sort((left, right) => right.score - left.score)[0]
}

function patternTrigger(route, pattern, fallback) {
  if (!(pattern?.score >= 70)) return fallback
  const values = {
    PLATFORM_BREAKOUT: {
      IMMEDIATE: '现价站稳近10日平台上沿且量能延续',
      PULLBACK: '回踩平台上沿后重新站稳，量能未失速',
      BREAKOUT: '放量突破近10日平台上沿并保持承接',
    },
    SUPPORT_PULLBACK: {
      IMMEDIATE: '现价守住MA20附近支撑且缩量结构未破坏',
      PULLBACK: '回踩MA20或结构支撑后重新站稳，资金未转弱',
      BREAKOUT: '回踩企稳后突破近期高点并保持承接',
    },
    VOLUME_PRICE_SURGE: {
      IMMEDIATE: '现价保持MA20上方且量价同步',
      PULLBACK: '回踩MA20后重新放量站稳',
      BREAKOUT: '放量突破近期高点且量能延续',
    },
    LOWER_SHADOW_REVERSAL: {
      IMMEDIATE: '长下影低点未失守且价格保持在分时均价上方',
      PULLBACK: '回踩下影承接区后重新站稳',
      BREAKOUT: '反击后突破当日高点并保持承接',
    },
    LOW_VOL_TREND: {
      IMMEDIATE: '低波动上行结构保持且现价未明显加速',
      PULLBACK: '回踩均线支撑后企稳，波动未异常放大',
      BREAKOUT: '低波动整理后突破近期高点',
    },
  }
  return values[pattern.id]?.[route] || fallback
}

function rewardMultiple(playbook, marketContext = {}) {
  const base = {
    MOMENTUM_BREAKOUT: 1.35,
    LEADER_PULLBACK: 1.65,
    ACCUMULATION: 1.9,
    CATALYST: 2.15,
    PANIC_REVERSAL: 1.55,
    RANGE_REVERSION: 1.4,
  }[playbook] || 1.6
  const factor = finite(marketContext.opportunityFactor) ?? 0.8
  return clamp(base + (factor - 0.8) * 0.45, 1.15, 2.4)
}

function plan({
  type,
  entry,
  stop,
  target,
  trigger,
  playbook,
  patternContext,
  now,
}) {
  const normalizedEntry = price(entry)
  const normalizedStop = price(stop)
  const normalizedTarget = price(target)
  if (!(
    normalizedEntry > 0
    && normalizedStop > 0
    && normalizedStop < normalizedEntry
    && normalizedTarget > normalizedEntry
  )) return null
  const risk = normalizedEntry - normalizedStop
  const reward = normalizedTarget - normalizedEntry
  return {
    schemaVersion: ADAPTIVE_PRICE_PLAN_VERSION,
    route: type,
    entryPlan: {
      type,
      price: normalizedEntry,
      window: type === 'IMMEDIATE'
        ? '当前连续竞价'
        : '未来1至3个交易日',
      trigger,
      maxPositionPct: 0,
      validUntil: Number(now) + (
        type === 'IMMEDIATE' ? 15 * 60 * 1000 : 3 * 86400000
      ),
    },
    exitPlan: {
      hardStopPrice: normalizedStop,
      takeProfitPrice: normalizedTarget,
      timeStopTradingDays: tradingDaysFor(playbook),
      rule: '结构失效、目标到达或相对机会价值转负时，以先发生者为准',
      t1Constraint: '当日买入不可卖出，下一可卖时段优先处理风险',
    },
    riskReward: +(reward / risk).toFixed(2),
    patternContext: patternContext?.score >= 70
      ? patternContext
      : null,
  }
}

export function buildAdaptivePricePlans({
  candidate = {},
  candles = [],
  trends = [],
  marketContext = {},
  now = Date.now(),
} = {}) {
  const quote = candidate.quote || {}
  const current = price(quote.price)
  if (!(current > 0)) return []
  const rows = normalizedCandles(candles)
  const atr = finite(
    candidate.technical?.atr
    ?? candidate.tech?.atr?.atr
    ?? candidate.tech?.atr
    ?? atr14(rows),
  ) || current * 0.025
  const ma5 = average(rows.slice(-5).map((item) => item.close))
  const ma10 = average(rows.slice(-10).map((item) => item.close))
  const ma20 = average(rows.slice(-20).map((item) => item.close))
  const support = finite(
    candidate.technical?.support
    ?? candidate.tech?.sr?.support
    ?? candidate.tech?.support,
  )
  const resistance = finite(
    candidate.technical?.resistance
    ?? candidate.tech?.sr?.resistance
    ?? candidate.tech?.resistance,
  )
  const recentHigh = rows.length
    ? Math.max(...rows.slice(-10).map((item) => item.high))
    : finite(quote.high)
  const recentLow = rows.length
    ? Math.min(...rows.slice(-5).map((item) => item.low))
    : finite(quote.low)
  const trendRows = Array.isArray(trends) ? trends : []
  const vwap = finite(trendRows.at(-1)?.avg ?? trendRows.at(-1)?.vwap)
  const playbooks = scoreOpportunityPlaybooks(candidate, marketContext)
  const playbook = playbooks.selected?.key
  const pattern = candidate.strategyPatternPolicy === 'ACTIVE'
    ? strongestPattern(candidate.shadowFeatures)
    : null
  const patternFeatures = candidate.shadowFeatures || {}
  const patternActive = pattern?.score >= 70
    && Number(patternFeatures.patternHistoryCoverage) >= 0.35
  const anchoredPrice = (distance) => finite(distance) != null
    && 1 + Number(distance) / 100 > 0
    ? price(current / (1 + Number(distance) / 100)) : null
  const platformHigh = patternActive
    ? anchoredPrice(patternFeatures.patternBreakoutDistance10Pct) : null
  const patternMa20 = patternActive
    ? anchoredPrice(patternFeatures.patternMa20DistancePct) : null
  const patternSupport = patternActive
    ? pattern.id === 'PLATFORM_BREAKOUT' ? platformHigh
      : ['SUPPORT_PULLBACK', 'VOLUME_PRICE_SURGE', 'LOW_VOL_TREND'].includes(pattern.id)
        ? patternMa20
        : pattern.id === 'LOWER_SHADOW_REVERSAL' ? price(quote.low) : null
    : null
  const rewardR = rewardMultiple(playbook, marketContext)
  const routeRisk = {
    IMMEDIATE: Math.max(atr * 0.9, current * 0.018),
    PULLBACK: Math.max(atr * 0.75, current * 0.015),
    BREAKOUT: Math.max(atr * 1.05, current * 0.022),
  }
  const pullbackAnchors = [
    vwap,
    ma5,
    ma10,
    ...(pattern?.score >= 70 ? [ma20] : []),
    support,
    current - atr * 0.45,
  ]
    .map(price)
    .filter((value) => value > 0 && value < current)
    .sort((left, right) => right - left)
  const breakoutReference = patternActive && pattern.id === 'PLATFORM_BREAKOUT'
    ? platformHigh || recentHigh : recentHigh
  const breakoutEntry = legalPrice(
    Math.max(current * 1.003, (breakoutReference || current) * 1.001),
    quote,
  )
  const immediateStop = legalPrice(
    Math.max(
      current - routeRisk.IMMEDIATE,
      ...(support > 0 && support < current ? [support - atr * 0.15] : []),
      ...(recentLow > 0 && recentLow < current ? [recentLow - atr * 0.1] : []),
    ),
    quote,
  )
  const immediateTarget = price(
    Math.max(
      current + routeRisk.IMMEDIATE * rewardR,
      resistance > current ? resistance : 0,
    ),
    quote,
  )
  const values = [
    plan({
      type: 'IMMEDIATE',
      entry: current,
      stop: immediateStop,
      target: immediateTarget,
      trigger: patternTrigger(
        'IMMEDIATE',
        pattern,
        '现价保持在分时均价上方且主逻辑未失效',
      ),
      playbook,
      patternContext: pattern,
      now,
    }),
  ]
  const reachablePatternSupport = legalPrice(patternSupport, quote)
  const pullbackEntry = reachablePatternSupport > 0
    && reachablePatternSupport < current
    && current - reachablePatternSupport <= atr * 1.8
    ? reachablePatternSupport : pullbackAnchors[0]
  if (pullbackEntry > 0 && current - pullbackEntry <= atr * 1.8) {
    const risk = routeRisk.PULLBACK
    values.push(plan({
      type: 'PULLBACK',
      entry: pullbackEntry,
      stop: legalPrice(pullbackEntry - risk, quote),
      target: price(
        Math.max(pullbackEntry + risk * rewardR, resistance || 0),
      ),
      trigger: patternTrigger(
        'PULLBACK',
        pattern,
        `回踩${pullbackEntry.toFixed(2)}元后重新站稳，资金未继续转弱`,
      ),
      playbook,
      patternContext: pattern,
      now,
    }))
  }
  if (
    breakoutEntry > current
    && breakoutEntry - current <= atr * 1.8
  ) {
    const risk = routeRisk.BREAKOUT
    values.push(plan({
      type: 'BREAKOUT',
      entry: breakoutEntry,
      stop: legalPrice(breakoutEntry - risk, quote),
      target: price(breakoutEntry + risk * rewardR),
      trigger: patternTrigger(
        'BREAKOUT',
        pattern,
        `放量突破${breakoutEntry.toFixed(2)}元并保持承接`,
      ),
      playbook,
      patternContext: pattern,
      now,
    }))
  }
  return values.filter(Boolean)
}

export function chooseAdaptivePricePlan({
  candidate = {},
  candles = [],
  trends = [],
  marketContext = {},
  now = Date.now(),
} = {}) {
  const plans = buildAdaptivePricePlans({
    candidate,
    candles,
    trends,
    marketContext,
    now,
  }).map((candidatePlan) => {
    const enriched = {
      ...candidate,
      entryPlan: candidatePlan.entryPlan,
      exitPlan: candidatePlan.exitPlan,
      riskReward: candidatePlan.riskReward,
      blockers: [],
    }
    return {
      ...candidatePlan,
      adaptive: evaluateSelectionActionValue(enriched, marketContext),
    }
  }).sort((left, right) =>
    Number(right.adaptive.utility ?? -Infinity)
      - Number(left.adaptive.utility ?? -Infinity)
    || Number(right.adaptive.playbook?.score || 0)
      - Number(left.adaptive.playbook?.score || 0),
  )
  return {
    schemaVersion: ADAPTIVE_PRICE_PLAN_VERSION,
    selected: plans[0] || null,
    alternatives: plans.slice(1),
  }
}
