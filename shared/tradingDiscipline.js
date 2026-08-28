// 交易纪律与真实业绩：面向新手的"少犯错、控仓位、执行纪律"内核。
// 全部为纯函数，前端(卡片/账户区)与后端可共用；不预测、不承诺收益，
// 只把用户真实成交的扣费后事实和高频/连亏/费用拖累如实照出来。
import { beijingDayStartTs } from './portfolioAccounting.js'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value, digits = 2) {
  const number = finite(value)
  if (number == null) return null
  const factor = 10 ** digits
  return Math.round(number * factor) / factor
}

// 已实现出场记录：卖出/清仓/做T卖腿，且有可信的扣费后已实现盈亏。
function isRealizedExit(record) {
  const type = record?.type || record?.kind
  if (!['SELL', 'CLOSE', 'T'].includes(type)) return false
  return finite(record?.realizedPnl ?? record?.netPnl) != null
}

function exitTimestamp(record) {
  return Number(record?.at || record?.sellAt || record?.buyAt || 0)
}

function tradeTimestamp(record) {
  return Number(record?.at || record?.sellAt || record?.buyAt || 0)
}

// 真实业绩镜子：只统计用户真实成交、扣费后的已实现结果，
// 与"军师决策命中率"是两码事——这是你账户里真金白银的胜率与成本拖累。
export function realPerformanceMirror(closed = [], { minimumSamples = 5 } = {}) {
  const exits = (Array.isArray(closed) ? closed : []).filter(isRealizedExit)
  const samples = exits.length
  let wins = 0
  let losses = 0
  let grossProfit = 0
  let grossLoss = 0
  let netPnl = 0
  let totalFees = 0
  for (const record of exits) {
    const pnl = finite(record.realizedPnl ?? record.netPnl) || 0
    netPnl += pnl
    if (pnl > 0) {
      wins++
      grossProfit += pnl
    } else if (pnl < 0) {
      losses++
      grossLoss += Math.abs(pnl)
    }
    const buyFee = Math.max(0, finite(record.buyFee) || 0)
    const sellFee = Math.max(0, finite(record.sellFee) || 0)
    totalFees += buyFee + sellFee
  }
  const qualified = samples >= Math.max(1, Math.trunc(minimumSamples))
  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : grossProfit > 0 ? null : 0
  // 手续费拖累：累计费用相对累计毛利的占比，直观说明"赚的钱被手续费吃掉多少"。
  const grossPnl = netPnl + totalFees
  const feeDragPct = grossProfit > 0
    ? Math.min(100, totalFees / grossProfit * 100)
    : null
  return {
    schemaVersion: 'real-performance-mirror.v1',
    samples,
    qualified,
    wins,
    losses,
    winRate: samples ? round(wins / samples * 100, 1) : null,
    netPnl: round(netPnl),
    grossPnl: round(grossPnl),
    averageNetPnl: samples ? round(netPnl / samples) : null,
    profitFactor: profitFactor == null ? null : round(profitFactor),
    totalFees: round(totalFees),
    feeDragPct: feeDragPct == null ? null : round(feeDragPct, 1),
    // 一句白话结论，扫读即懂；样本不足时明确说"还看不准"。
    verdict: verdictFor({
      qualified, samples, netPnl, winRate: samples ? wins / samples * 100 : null,
      profitFactor,
    }),
  }
}

function verdictFor({ qualified, samples, netPnl, winRate, profitFactor }) {
  if (!qualified) return `真实成交样本还太少（${samples}笔），先按纪律积累`
  if (netPnl < 0) return '扣掉手续费后目前是亏的，务必收紧频率和止损'
  if (profitFactor != null && profitFactor < 1) return '盈亏比小于1，赚的没亏的多，先减少出手'
  if (winRate != null && winRate < 45) return '胜率偏低，靠的是少数大赚，别追高摊薄赔率'
  return '扣费后暂时为正，继续保持纪律，别放大仓位'
}

// 连亏计数：从最近一笔出场往回数连续亏损，可限定"今日"。
function consecutiveLosses(exits, since = null) {
  const ordered = exits
    .filter((record) => since == null || exitTimestamp(record) >= since)
    .sort((left, right) => exitTimestamp(right) - exitTimestamp(left))
  let count = 0
  for (const record of ordered) {
    const pnl = finite(record.realizedPnl ?? record.netPnl)
    if (!(pnl < 0)) break
    count++
  }
  return count
}

// 行为护栏：把散户最容易犯的三件事——交易过频、连亏还硬刚、手续费吃利润——
// 用实时可见的白话预警照出来。返回按严重度排序的告警数组，空数组=当前无警示。
export function behaviorGuardrails(
  {
    closed = [],
    now = Date.now(),
    maxTradesPerDay = 6,
    lossStreakCooldown = 3,
  } = {},
) {
  const exits = (Array.isArray(closed) ? closed : []).filter(isRealizedExit)
  const dayStart = beijingDayStartTs(now)
  const alerts = []

  // 1) 交易频率：今日出场次数超阈值 → 提醒过度交易只喂手续费。
  const todayTrades = (Array.isArray(closed) ? closed : []).filter(
    (record) => tradeTimestamp(record) >= dayStart
      && ['SELL', 'CLOSE', 'T', 'BUY'].includes(record?.type || record?.kind),
  ).length
  if (todayTrades >= maxTradesPerDay) {
    alerts.push({
      code: 'OVER_TRADING',
      level: 'warn',
      icon: 'activity',
      title: '今日交易偏频繁',
      message: `今天已经动手 ${todayTrades} 次，频繁进出主要在喂手续费；先停一停，只做最有把握的一笔。`,
    })
  }

  // 2) 连亏冷静期：连续亏损达到阈值 → 强烈建议今日收手，避免报复性交易。
  const streak = consecutiveLosses(exits)
  const dailyStreak = consecutiveLosses(exits, dayStart)
  if (dailyStreak >= lossStreakCooldown) {
    alerts.push({
      code: 'LOSS_STREAK_COOLDOWN',
      level: 'danger',
      icon: 'shield',
      title: '连亏了，先冷静',
      message: `今天已连续亏损 ${dailyStreak} 笔，情绪上头最容易报复性追单；今日建议收手，明天再按计划来。`,
    })
  } else if (streak >= lossStreakCooldown) {
    alerts.push({
      code: 'LOSS_STREAK',
      level: 'warn',
      icon: 'shield',
      title: '最近连亏',
      message: `最近连续 ${streak} 笔亏损，先把仓位降下来、只打最确定的机会，别急着回本。`,
    })
  }

  // 3) 手续费拖累：累计费用吃掉毛利超三成 → 明确点破成本正在侵蚀收益。
  const mirror = realPerformanceMirror(closed)
  if (
    mirror.qualified
    && mirror.feeDragPct != null
    && mirror.feeDragPct >= 30
  ) {
    alerts.push({
      code: 'FEE_DRAG',
      level: 'warn',
      icon: 'coins',
      title: '手续费在吃利润',
      message: `累计手续费约 ${mirror.totalFees} 元，吃掉了毛利的 ${mirror.feeDragPct}%；出手越频、持有越短，这块拖累越大。`,
    })
  }

  return {
    schemaVersion: 'behavior-guardrails.v1',
    todayTrades,
    lossStreak: streak,
    dailyLossStreak: dailyStreak,
    alerts,
  }
}
