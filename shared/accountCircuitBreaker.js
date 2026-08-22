import { beijingDayStartTs } from './portfolioAccounting.js'

const ACTIVE_PLAN_STATES = new Set([
  'ARMED',
  'ALERTED',
  'USER_CONFIRMED',
  'PARTIALLY_RECORDED',
])

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function breaker(code, message, value = null, limit = null) {
  return { code, message, value, limit }
}

function consecutiveLossCount(closed = []) {
  let count = 0
  const exits = closed
    .filter((item) =>
      ['SELL', 'T'].includes(item?.type || item?.kind)
      && finite(item?.realizedPnl ?? item?.netPnl) != null
    )
    .sort((left, right) =>
      Number(right.at || right.sellAt || 0)
      - Number(left.at || left.sellAt || 0)
    )
  for (const trade of exits) {
    const pnl = finite(trade.realizedPnl ?? trade.netPnl)
    if (!(pnl < 0)) break
    count++
  }
  return count
}

export function evaluateAccountCircuitBreaker({
  account = {},
  portfolio = {},
  closed = [],
  executionPlans = [],
  now = Date.now(),
  limits = {},
} = {}) {
  const totalAssets = Math.max(0, finite(account.totalAssets) || 0)
  const cash = Math.max(0, finite(account.cash) || 0)
  const startAssets = Math.max(
    0,
    finite(account.dayStartAssets) || totalAssets,
  )
  const maximumDailyRealizedLossPct = finite(
    limits.maximumDailyRealizedLossPct,
  ) ?? 2
  const maximumDailyDrawdownPct = finite(
    limits.maximumDailyDrawdownPct,
  ) ?? 3
  const maximumConsecutiveLosses = Math.max(
    1,
    Math.trunc(finite(limits.maximumConsecutiveLosses) || 3),
  )
  const maximumPositionPct = finite(limits.maximumPositionPct) ?? 85
  const minimumCashReservePct = finite(limits.minimumCashReservePct) ?? 10
  const maximumIndustryWeightPct = finite(
    limits.maximumIndustryWeightPct,
  ) ?? 30
  const dayStart = beijingDayStartTs(now)
  const realizedPnl = (closed || [])
    .filter((item) =>
      Number(item?.at || item?.sellAt || 0) >= dayStart
      && finite(item?.realizedPnl ?? item?.netPnl) != null
    )
    .reduce(
      (sum, item) =>
        sum + Number(item.realizedPnl ?? item.netPnl),
      0,
    )
  const realizedLossPct = totalAssets > 0 && realizedPnl < 0
    ? Math.abs(realizedPnl) / totalAssets * 100
    : 0
  const drawdownPct = startAssets > 0 && totalAssets < startAssets
    ? (startAssets - totalAssets) / startAssets * 100
    : 0
  const consecutiveLosses = consecutiveLossCount(closed)
  const activePlans = (executionPlans || []).filter(
    (plan) => ACTIVE_PLAN_STATES.has(plan?.status),
  )
  const reservedBuyCash = activePlans
    .filter((plan) => plan.side === 'BUY')
    .reduce(
      (sum, plan) => sum + Math.max(0, finite(plan.reservedCash) || 0),
      0,
    )
  const pendingSellProceeds = activePlans
    .filter((plan) => plan.side === 'SELL')
    .reduce(
      (sum, plan) =>
        sum + Math.max(0, finite(plan.expectedNetProceeds) || 0),
      0,
    )
  const availableCashAfterReservations = Math.max(
    0,
    cash - reservedBuyCash,
  )
  const cashReservePct = totalAssets > 0
    ? availableCashAfterReservations / totalAssets * 100
    : 0
  const positionPct = Math.max(0, finite(portfolio.position) || 0)
  const maximumIndustry = (portfolio.industryWeights || [])
    .reduce((maximum, item) =>
      Math.max(maximum, finite(item?.weight) || 0)
    , 0)
  const blockers = []
  if (realizedLossPct >= maximumDailyRealizedLossPct) {
    blockers.push(breaker(
      'DAILY_REALIZED_LOSS',
      '当日已实现亏损达到熔断线',
      +realizedLossPct.toFixed(2),
      maximumDailyRealizedLossPct,
    ))
  }
  if (drawdownPct >= maximumDailyDrawdownPct) {
    blockers.push(breaker(
      'DAILY_DRAWDOWN',
      '当日总资产回撤达到熔断线',
      +drawdownPct.toFixed(2),
      maximumDailyDrawdownPct,
    ))
  }
  if (consecutiveLosses >= maximumConsecutiveLosses) {
    blockers.push(breaker(
      'CONSECUTIVE_LOSSES',
      '连续亏损进入冷却期',
      consecutiveLosses,
      maximumConsecutiveLosses,
    ))
  }
  if (positionPct >= maximumPositionPct) {
    blockers.push(breaker(
      'MAX_POSITION',
      '总仓位达到上限',
      positionPct,
      maximumPositionPct,
    ))
  }
  if (cashReservePct < minimumCashReservePct) {
    blockers.push(breaker(
      'CASH_RESERVE',
      '未完成买入占用后现金储备不足',
      +cashReservePct.toFixed(2),
      minimumCashReservePct,
    ))
  }
  if (maximumIndustry >= maximumIndustryWeightPct) {
    blockers.push(breaker(
      'INDUSTRY_CONCENTRATION',
      '行业合并暴露达到上限',
      maximumIndustry,
      maximumIndustryWeightPct,
    ))
  }
  const allowRiskIncrease = blockers.length === 0
  return {
    schemaVersion: 'account-circuit-breaker.v1',
    allowRiskIncrease,
    blockerCodes: blockers.map((item) => item.code),
    blockers,
    metrics: {
      realizedPnl: +realizedPnl.toFixed(2),
      realizedLossPct: +realizedLossPct.toFixed(2),
      drawdownPct: +drawdownPct.toFixed(2),
      consecutiveLosses,
      positionPct,
      cashReservePct: +cashReservePct.toFixed(2),
      maximumIndustryWeightPct: maximumIndustry,
    },
    reservedBuyCash: +reservedBuyCash.toFixed(2),
    availableCashAfterReservations:
      +availableCashAfterReservations.toFixed(2),
    pendingSellProceeds: +pendingSellProceeds.toFixed(2),
    pendingSellProceedsRecognized: 0,
    allowedActions: allowRiskIncrease
      ? ['BUY', 'ADD', 'REDUCE', 'EXIT', 'WATCH']
      : ['REDUCE', 'EXIT', 'WATCH'],
  }
}
