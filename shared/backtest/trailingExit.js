// 跟踪出场策略（移动止盈 / ATR 跟踪止损）。
//
// 动机：固定止盈(如+9%)会砍掉大赢家，固定时间止损会过早离场。跟踪止损让
// 盈利单"让利润奔跑"，只在从最高点回撤超过阈值时离场——这会改变收益分布
// 的右尾，可能把负期望的裸信号救成正期望（也可能无效，用回测证伪）。
//
// 用法：策略只产出 BUY 进场信号（可含 plan.stopPrice 作初始止损）；本模块吃
// 进场信号 + 日线，模拟每笔持仓的跟踪出场，产出完整 signals（含 SELL）交给
// 引擎按次日开盘成交。引擎成本/T+1 口径不变。

function finite(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// 简易 ATR（14日）用于 ATR 跟踪止损；bars 升序。
function atrAt(rows, index, period = 14) {
  if (index < period) return null
  let sum = 0
  for (let i = index - period + 1; i <= index; i += 1) {
    const cur = rows[i]
    const prev = rows[i - 1]
    if (!cur || !prev) return null
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    )
    sum += tr
  }
  return sum / period
}

export const TRAILING_DEFAULTS = Object.freeze({
  mode: 'pct', // 'pct' 按百分比回撤 | 'atr' 按ATR倍数
  trailPct: 6, // 从持仓最高价回撤该百分比即止损离场
  atrMult: 2.5, // ATR 模式：止损 = 最高价 - atrMult*ATR
  initialStopPct: 5, // 初始止损（进场即生效，未创新高前的保护）
  activateProfitPct: 3, // 浮盈达该百分比后才启用跟踪（避免刚进场就被洗）
  maxHoldDays: 20, // 硬时间上限，防止无限持有
})

// entrySignals: 仅 BUY，含 { date, lots }。bars 升序日线。
// 返回完整 signals（BUY 原样 + 生成的 SELL）。单持仓（配合现有单标的引擎）。
export function applyTrailingExits(entrySignals = [], bars = [], config = {}) {
  const cfg = { ...TRAILING_DEFAULTS, ...config }
  const rows = (Array.isArray(bars) ? bars : [])
    .filter((b) => b?.date && finite(b.close) != null)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  const dateToIndex = new Map(rows.map((b, i) => [b.date, i]))
  // 进场按执行日（信号次日）索引
  const buysByExecIndex = new Map()
  for (const sig of Array.isArray(entrySignals) ? entrySignals : []) {
    if (String(sig.side).toUpperCase() !== 'BUY') continue
    const idx = dateToIndex.get(String(sig.date).replaceAll('-', ''))
    if (idx == null || idx + 1 >= rows.length) continue
    if (!buysByExecIndex.has(idx + 1)) buysByExecIndex.set(idx + 1, sig)
  }

  const out = []
  let position = null // { entryIndex, entryPrice, highWater }

  for (let index = 0; index < rows.length; index += 1) {
    const bar = rows[index]
    if (position) {
      // 更新最高水位
      if (finite(bar.high) != null && bar.high > position.highWater) {
        position.highWater = bar.high
      }
      const held = index - position.entryIndex
      const profitPct = (position.highWater - position.entryPrice) / position.entryPrice * 100
      // 计算当前止损线
      let stopLine
      if (profitPct >= cfg.activateProfitPct) {
        if (cfg.mode === 'atr') {
          const atr = atrAt(rows, index) ?? (position.entryPrice * cfg.initialStopPct / 100)
          stopLine = position.highWater - cfg.atrMult * atr
        } else {
          stopLine = position.highWater * (1 - cfg.trailPct / 100)
        }
        // 跟踪止损不低于初始止损
        stopLine = Math.max(stopLine, position.entryPrice * (1 - cfg.initialStopPct / 100))
      } else {
        // 未激活跟踪：用初始止损
        stopLine = position.entryPrice * (1 - cfg.initialStopPct / 100)
      }
      let exit = ''
      if (finite(bar.low) != null && bar.low <= stopLine) {
        exit = profitPct >= cfg.activateProfitPct ? '跟踪止损' : '初始止损'
      } else if (held >= cfg.maxHoldDays) {
        exit = `持有${held}日时间上限`
      }
      if (exit) {
        out.push({ date: bar.date, side: 'SELL', lots: position.lots, reason: exit })
        position = null
      }
      continue
    }
    const buy = buysByExecIndex.get(index)
    if (buy) {
      const entryPrice = finite(bar.open) ?? finite(bar.close)
      if (entryPrice == null) continue
      out.push({ date: buy.date, side: 'BUY', lots: buy.lots || 1, reason: buy.reason })
      position = {
        entryIndex: index,
        entryPrice,
        highWater: finite(bar.high) ?? entryPrice,
        lots: buy.lots || 1,
      }
    }
  }
  return out
}

// 从任意策略产出的 signals 中只保留进场（BUY），丢弃其自带出场，
// 便于用跟踪出场替换。
export function entriesOnly(signals = []) {
  return (Array.isArray(signals) ? signals : [])
    .filter((s) => String(s.side).toUpperCase() === 'BUY')
    .map((s) => ({ date: s.date, side: 'BUY', lots: s.lots || 1, reason: s.reason }))
}
