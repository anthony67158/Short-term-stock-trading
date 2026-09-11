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
  const rewardR = rewardMultiple(playbook, marketContext)
  const routeRisk = {
    IMMEDIATE: Math.max(atr * 0.9, current * 0.018),
    PULLBACK: Math.max(atr * 0.75, current * 0.015),
    BREAKOUT: Math.max(atr * 1.05, current * 0.022),
  }
  const pullbackAnchors = [vwap, ma5, ma10, support, current - atr * 0.45]
    .map(price)
    .filter((value) => value > 0 && value < current)
    .sort((left, right) => right - left)
  const breakoutEntry = legalPrice(
    Math.max(current * 1.003, (recentHigh || current) * 1.001),
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
      trigger: '现价保持在分时均价上方且主逻辑未失效',
      playbook,
      now,
    }),
  ]
  const pullbackEntry = pullbackAnchors[0]
  if (pullbackEntry > 0 && current - pullbackEntry <= atr * 1.8) {
    const risk = routeRisk.PULLBACK
    values.push(plan({
      type: 'PULLBACK',
      entry: pullbackEntry,
      stop: legalPrice(pullbackEntry - risk, quote),
      target: price(
        Math.max(pullbackEntry + risk * rewardR, resistance || 0),
      ),
      trigger: `回踩${pullbackEntry.toFixed(2)}元后重新站稳，资金未继续转弱`,
      playbook,
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
      trigger: `放量突破${breakoutEntry.toFixed(2)}元并保持承接`,
      playbook,
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
