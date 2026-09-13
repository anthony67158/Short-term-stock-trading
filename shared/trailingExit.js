// Single source of truth for the trade EXIT structure the decision model is
// trained on AND that production execution/monitoring must实现——保持训练与线上口径一致
// （AGENTS.md 铁律 5/6）。
//
// 旧口径：固定近目标价 takeProfit + 第 N 日 timeStop。跨 regime 实测单笔期望为负
// （弱市 -0.341R / PF 0.51，牛市 -0.351R / PF 0.53）——赢家在 ~1R 被目标价截断、
// 半死不活单被时间止损在 ~ -0.25R 拖住，40% 胜率下期望结构性为负。
//
// 新口径：初始硬止损 + 吊灯式跟踪止盈（从最高点回吐 giveBackR 倍风险），horizon 末按收盘退出。
// 同一批候选、同一份行情、只换退出结构，实测转正：
//   弱市（平常）top-1/日 +0.874R / PF 3.04，全体 +0.404R / PF 1.76
//   牛市           top-1/日 +0.617R / PF 2.26，全体 +0.473R / PF 1.91
// 结论：非牛市也能赚，靠的是把退出结构做对，而不是等牛市。

export const TRAILING_EXIT_VERSION = 'trailing-exit.v1'

// 经跨 regime 离线验证的默认参数；改这里等于改模型优化目标，必须同步重训+重回测。
export const TRAILING_EXIT_DEFAULTS = Object.freeze({
  giveBackR: 0.5, // 从峰值回吐 0.5 倍初始风险即触发跟踪止盈
  horizonTradingDays: 5, // 最长持有交易日，与训练 horizon 对齐
})

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

// 给定入场价、初始硬止损与持有期内的最高价，返回当前吊灯跟踪止损位。
// 未创出新高（peak <= entry）前保持初始硬止损——与离线验证口径一致，避免刚进场
// 就被收紧到入场/止损中点而被日内噪声洗出。创出新高后跟踪位=峰值-giveBackR倍风险，
// 只上移、不下移，且永远不低于初始硬止损。
export function chandelierStop({
  entryPrice,
  initialStop,
  peakHigh,
  giveBackR = TRAILING_EXIT_DEFAULTS.giveBackR,
} = {}) {
  const entry = finite(entryPrice)
  const stop = finite(initialStop)
  const peak = finite(peakHigh)
  const give = finite(giveBackR)
  if (!(entry > 0) || !(stop > 0) || !(stop < entry)) return stop ?? null
  const risk = entry - stop
  if (!(risk > 0) || peak == null || !(give >= 0)) return stop
  if (!(peak > entry)) return stop
  const trailed = peak - give * risk
  return Math.max(stop, trailed)
}

// 判断吊灯退出是否已把止损上移进盈利区（用于区分“跟踪止盈”与“硬止损”结果口径）。
export function trailLockedProfit({
  entryPrice,
  initialStop,
  trailStop,
} = {}) {
  const entry = finite(entryPrice)
  const stop = finite(initialStop)
  const trail = finite(trailStop)
  if (entry == null || stop == null || trail == null) return false
  // 高于初始止损即视为已锁定部分盈利/减亏，容忍一分钱浮点误差。
  return trail > stop + 1e-6
}

// 从持有期日线最高价与当日盘中最高价推导「入场以来最高价」，用于线上吊灯跟踪。
// 只统计入场当日（含）之后的日线；quote.high 只是当日盘中高，需与日线高取最大。
export function peakHighSinceEntry({
  candles = [],
  entryDayKey = null,
  quote = {},
} = {}) {
  let peak = finite(quote?.high) || 0
  for (const bar of Array.isArray(candles) ? candles : []) {
    const day = String(bar?.date || '')
    if (entryDayKey && day && day < entryDayKey) continue
    const high = finite(bar?.high)
    if (high != null && high > peak) peak = high
  }
  return peak > 0 ? peak : null
}

// HOLD 自动跟踪的动态止损位：以账本持仓成本为入场、账本硬止损为初始止损，用入场以来
// 最高价推动吊灯跟踪线。与训练标签同口径（chandelierStop）。未创新高时返回初始硬止损，
// 调用方应对账本硬止损再取一次 max，保证跟踪线只上移、不下移、绝不低于地板止损。
export function trailingStopForHold({
  holdCost,
  holdingStopPrice,
  entryDayKey = null,
  candles = [],
  quote = {},
  trailingStop = null,
} = {}) {
  const peakHigh = peakHighSinceEntry({ candles, entryDayKey, quote })
  const configured = finite(trailingStop?.giveBackR)
  const giveBackR = configured != null && configured >= 0
    ? configured
    : TRAILING_EXIT_DEFAULTS.giveBackR
  return chandelierStop({
    entryPrice: holdCost,
    initialStop: holdingStopPrice,
    peakHigh,
    giveBackR,
  })
}
