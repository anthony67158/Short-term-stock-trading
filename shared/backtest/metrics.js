// 回测绩效指标：从 round-trip 交易列表算出"到底赚不赚钱"的度量。
//
// 全部为纯函数。核心是【单笔扣费后期望】expectancyPerTrade —— 它 > 0
// 才代表这套打法在扣掉佣金/印花/滑点后具备正统计优势，是允许接入实盘的
// 唯一硬门槛。其余指标（盈亏比、盈利因子、夏普、最大回撤）用于判断这份
// 期望是否稳健、可承受。

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value, digits = 2) {
  const number = finite(value)
  return number == null ? null : +number.toFixed(digits)
}

function mean(values) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stdev(values) {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values
    .reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

// 逐笔收益率序列的最大回撤（以累计净值计），返回正的百分比。
function maxDrawdownPct(returnPcts) {
  let equity = 1
  let peak = 1
  let maxDd = 0
  for (const pct of returnPcts) {
    equity *= 1 + pct / 100
    if (equity > peak) peak = equity
    const dd = (peak - equity) / peak
    if (dd > maxDd) maxDd = dd
  }
  return +(maxDd * 100).toFixed(2)
}

export function computeBacktestMetrics(trades = [], options = {}) {
  const list = (Array.isArray(trades) ? trades : [])
    .filter((trade) => finite(trade?.netPnl) != null)
  const total = list.length
  if (!total) {
    return {
      trades: 0,
      profitable: false,
      note: '无完整round-trip交易，无法评估期望',
    }
  }

  const pnls = list.map((trade) => Number(trade.netPnl))
  const returnPcts = list
    .map((trade) => finite(trade.returnPct))
    .filter((value) => value != null)
  const wins = list.filter((trade) => Number(trade.netPnl) > 0)
  const losses = list.filter((trade) => Number(trade.netPnl) < 0)
  const grossProfit = wins.reduce((sum, t) => sum + Number(t.netPnl), 0)
  const grossLoss = Math.abs(
    losses.reduce((sum, t) => sum + Number(t.netPnl), 0),
  )
  const winRate = wins.length / total
  const avgWin = wins.length ? grossProfit / wins.length : 0
  const avgLoss = losses.length ? grossLoss / losses.length : 0
  // 盈亏比：平均盈利 / 平均亏损
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : null
  // 单笔扣费后期望（金额）：直接反映每交易一次赚多少钱
  const expectancyCash = mean(pnls)
  // 单笔扣费后期望（收益率）：跨标的可比
  const expectancyPct = returnPcts.length ? mean(returnPcts) : null
  // 盈利因子：总盈利 / 总亏损，>1 才赚钱
  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : grossProfit > 0 ? Infinity : 0
  // 逐笔收益率夏普（非年化，用于横向比较稳健度）
  const retStd = stdev(returnPcts)
  const sharpe = retStd > 0 && returnPcts.length
    ? mean(returnPcts) / retStd
    : null
  const holdingDays = list
    .map((trade) => finite(trade.holdingDays))
    .filter((value) => value != null)

  // 放行门槛用【收益率期望】而非现金期望：不同笔仓位规模不同，
  // 直接汇总现金会被大仓位单笔带偏；跨笔可比的是每笔收益率均值。
  // 需同时满足：样本内收益率期望 > 0 且盈利因子 > 1，才算具备真实优势。
  const expectancyPositive = (
    expectancyPct != null
    && expectancyPct > 0
    && profitFactor > 1
  )

  return {
    trades: total,
    wins: wins.length,
    losses: losses.length,
    winRatePct: round(winRate * 100),
    avgWinCash: round(avgWin),
    avgLossCash: round(avgLoss),
    payoffRatio: round(payoffRatio, 2),
    // —— 核心门槛 ——
    expectancyCash: round(expectancyCash),
    expectancyPct: round(expectancyPct, 3),
    expectancyPositive,
    // —— 稳健度 ——
    profitFactor: profitFactor === Infinity ? Infinity : round(profitFactor, 2),
    sharpePerTrade: round(sharpe, 3),
    maxDrawdownPct: maxDrawdownPct(returnPcts),
    totalNetPnl: round(pnls.reduce((sum, value) => sum + value, 0)),
    avgHoldingDays: holdingDays.length ? round(mean(holdingDays), 1) : null,
    // 一句话结论：能不能接入实盘（以收益率期望为准）
    verdict: expectancyPositive
      ? `扣费后单笔收益率期望 ${round(expectancyPct, 3)}%（现金 ${round(expectancyCash)} 元）、盈利因子 ${profitFactor === Infinity ? '∞' : round(profitFactor, 2)}，具备正统计优势`
      : `扣费后单笔收益率期望 ${round(expectancyPct, 3)}%、盈利因子 ${profitFactor === Infinity ? '∞' : round(profitFactor, 2)}，不具备正优势，禁止接入实盘`,
    ...(options.label ? { label: String(options.label) } : {}),
  }
}
