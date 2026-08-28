// 策略：强势股回踩低吸（可回测的显式 playbook）。
//
// 核心逻辑（初版阈值，全部可回测迭代）：
//   1. 强势确认：近 momentumWindow 日涨幅 >= momentumMinPct，且当前价在
//      MA20 之上（趋势向上），近期出现过阶段新高。
//   2. 回踩触发：从近段高点回落，价格回踩到锚点（MA5 或 MA10）附近，
//      且回踩当日缩量（量能 < 近期均量 * volumeContractRatio）。
//   3. 企稳进场：回踩日收盘重新站上锚点（或收盘 > 开盘的阳线），视为
//      承接确认 → 次日开盘买入。
//   4. 退出：
//        - 止盈：入场后触及 takeProfitR 倍风险（R = 入场-止损）。
//        - 止损：跌破止损锚点（回踩低点下方 stopBufferPct）。
//        - 时间止损：持有 maxHoldDays 仍未止盈 → 次日退出（短线不恋战）。
//
// 输入 bars 为单标的按日期升序日线；输出 { date, side, lots, reason } 信号，
// 交由 engine 在次日开盘成交。策略只产出意图，不碰成本与成交口径。

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function sma(values, endIndex, window) {
  if (endIndex + 1 < window) return null
  let sum = 0
  for (let i = endIndex - window + 1; i <= endIndex; i += 1) {
    const value = finite(values[i])
    if (value == null) return null
    sum += value
  }
  return sum / window
}

function highestClose(bars, endIndex, window) {
  const start = Math.max(0, endIndex - window + 1)
  let peak = -Infinity
  for (let i = start; i <= endIndex; i += 1) {
    const close = finite(bars[i]?.close)
    if (close != null && close > peak) peak = close
  }
  return peak === -Infinity ? null : peak
}

export const PULLBACK_DIP_DEFAULTS = Object.freeze({
  momentumWindow: 20,
  momentumMinPct: 12,
  volumeAvgWindow: 5,
  volumeContractRatio: 0.85,
  anchor: 'ma10', // 'ma5' | 'ma10'
  anchorTouchPct: 1.5, // 回踩到锚点±该百分比内算触碰
  stopBufferPct: 1.5, // 止损设在回踩低点下方该百分比
  takeProfitR: 2.0, // 止盈 = 入场 + R * takeProfitR
  maxHoldDays: 5, // 超过则时间止损（次日退出）
  lots: 1,
  // —— 资金承接确认（可选，需传 moneyflowByDate）——
  requireFlowConfirm: false, // 开启后，企稳日附近须主力净流入
  flowConfirmWindow: 3, // 看企稳日往前 N 日的主力净流入合计
  flowMinNetWan: 0, // 主力净流入合计须 > 该阈值(万元)
})

function anchorValue(closes, index, anchor) {
  return anchor === 'ma5'
    ? sma(closes, index, 5)
    : sma(closes, index, 10)
}

// 企稳日往前 flowConfirmWindow 日的主力净流入合计（万元）。
// moneyflowByDate: { 'YYYYMMDD': { mainNetWan } }。缺数据返回 null（视为未确认）。
function mainFlowSum(rows, index, moneyflowByDate, window) {
  if (!moneyflowByDate) return null
  let sum = 0
  let seen = 0
  for (let i = Math.max(0, index - window + 1); i <= index; i += 1) {
    const flow = moneyflowByDate[rows[i]?.date]
    const net = flow == null ? null : Number(flow.mainNetWan)
    if (Number.isFinite(net)) { sum += net; seen += 1 }
  }
  return seen > 0 ? sum : null
}

export function generatePullbackDipSignals(bars = [], config = {}, {
  moneyflowByDate = null,
} = {}) {
  const cfg = { ...PULLBACK_DIP_DEFAULTS, ...config }
  const rows = (Array.isArray(bars) ? bars : [])
    .filter((bar) => finite(bar?.close) != null && bar?.date)
    .sort((left, right) => (left.date < right.date ? -1 : 1))
  const closes = rows.map((bar) => Number(bar.close))
  const volumes = rows.map((bar) => finite(bar.volume))
  const signals = []

  // 单持仓状态机：一次只持有一笔，退出后才找下一个进场。
  let position = null // { entryIndex, stopPrice, targetPrice }

  for (let index = 0; index < rows.length; index += 1) {
    const bar = rows[index]
    const close = closes[index]

    if (position) {
      const held = index - position.entryIndex
      let exitReason = ''
      if (finite(bar.low) != null && bar.low <= position.stopPrice) {
        exitReason = `跌破止损${position.stopPrice}`
      } else if (finite(bar.high) != null && bar.high >= position.targetPrice) {
        exitReason = `触及止盈${position.targetPrice}`
      } else if (held >= cfg.maxHoldDays) {
        exitReason = `持有${held}日时间止损`
      }
      if (exitReason) {
        signals.push({
          date: bar.date,
          side: 'SELL',
          lots: cfg.lots,
          reason: exitReason,
        })
        position = null
      }
      continue
    }

    // 需要足够历史算动量与均线。
    if (index < cfg.momentumWindow) continue
    const ma20 = sma(closes, index, 20)
    const anchor = anchorValue(closes, index, cfg.anchor)
    if (ma20 == null || anchor == null) continue

    // 1. 强势确认
    const past = closes[index - cfg.momentumWindow]
    const momentumPct = past > 0 ? ((close - past) / past) * 100 : null
    const peak = highestClose(rows, index, cfg.momentumWindow)
    const strongUptrend = (
      momentumPct != null
      && momentumPct >= cfg.momentumMinPct
      && close > ma20
      && peak != null
    )
    if (!strongUptrend) continue

    // 2. 回踩触碰锚点 + 缩量
    const touchedAnchor = (
      Math.abs((close - anchor) / anchor) * 100 <= cfg.anchorTouchPct
      || (finite(bar.low) != null && bar.low <= anchor && close >= anchor)
    )
    const avgVol = sma(volumes, index, cfg.volumeAvgWindow)
    const contracted = (
      avgVol == null
      || volumes[index] == null
      || volumes[index] <= avgVol * cfg.volumeContractRatio
    )
    // 回落幅度：确认是"从高点回踩"而非仍在拉升
    const pulledBack = peak != null && close < peak

    // 3. 企稳：收盘重新站上锚点（或收在锚点容差内），且为阳线（承接确认）。
    //    容差与回踩触碰同口径，避免"差一分钱不算站上"的脆弱判定。
    const reclaimedAnchor = (
      close >= anchor
      || Math.abs((close - anchor) / anchor) * 100 <= cfg.anchorTouchPct
    )
    const stabilized = (
      reclaimedAnchor
      && finite(bar.open) != null
      && close >= bar.open
    )

    if (touchedAnchor && contracted && pulledBack && stabilized) {
      // 资金承接确认：开启后，企稳日附近主力净流入合计须过阈值。
      // 缺资金数据时视为未确认（保守跳过），避免无据买入。
      if (cfg.requireFlowConfirm) {
        const flowSum = mainFlowSum(
          rows, index, moneyflowByDate, cfg.flowConfirmWindow,
        )
        if (flowSum == null || flowSum <= cfg.flowMinNetWan) continue
      }
      const pullbackLow = finite(bar.low) ?? close
      const stopPrice = +(pullbackLow * (1 - cfg.stopBufferPct / 100)).toFixed(2)
      const riskPerShare = close - stopPrice
      const targetPrice = riskPerShare > 0
        ? +(close + riskPerShare * cfg.takeProfitR).toFixed(2)
        : +(close * 1.05).toFixed(2)
      const riskReward = riskPerShare > 0
        ? +((targetPrice - close) / riskPerShare).toFixed(2)
        : null
      signals.push({
        date: bar.date,
        side: 'BUY',
        lots: cfg.lots,
        reason: `强势回踩${cfg.anchor}企稳(动量${momentumPct.toFixed(1)}%)`,
        // —— 可执行买入计划（下一交易日据此操作）——
        plan: {
          // 触发参考价：企稳日收盘，即"回踩到位、承接确认"的价格锚。
          // 次日开盘或回踩到该价附近即可按计划买入。
          entryTriggerPrice: +close.toFixed(2),
          stopPrice,
          targetPrice,
          riskPerShare: +riskPerShare.toFixed(2),
          riskReward,
          anchor: cfg.anchor,
          anchorPrice: +anchor.toFixed(2),
          momentumPct: +momentumPct.toFixed(1),
          maxHoldDays: cfg.maxHoldDays,
          entryWindow: '下一交易日盘中',
        },
      })
      position = {
        entryIndex: index,
        stopPrice,
        targetPrice,
      }
    }
  }

  return signals
}

// 从最新一段行情提取"当前是否给出买入计划"，供前端/接口直接展示：
// 什么时候买、以什么价买、止损止盈在哪、盈亏比多少。
// 只看最后一个信号是否落在最近 lookbackBars 根K线内（新鲜度），
// 避免把很久以前的历史买点当成当下可执行。
export function latestBuyPlan(bars = [], config = {}, {
  lookbackBars = 2,
  moneyflowByDate = null,
} = {}) {
  const signals = generatePullbackDipSignals(bars, config, { moneyflowByDate })
  const buys = signals.filter((s) => s.side === 'BUY' && s.plan)
  if (!buys.length) {
    return { actionable: false, reason: '当前无符合回踩低吸条件的买点' }
  }
  const rows = (Array.isArray(bars) ? bars : [])
    .filter((bar) => bar?.date)
    .sort((left, right) => (left.date < right.date ? -1 : 1))
  const lastDate = rows.at(-1)?.date
  const recentDates = new Set(rows.slice(-lookbackBars).map((bar) => bar.date))
  const latest = buys.at(-1)
  const fresh = recentDates.has(latest.date)
  return {
    actionable: fresh,
    signalDate: latest.date,
    asOfDate: lastDate,
    reason: fresh
      ? latest.reason
      : `最近买点在 ${latest.date}，已超出 ${lookbackBars} 日新鲜窗口，需回踩重新确认`,
    plan: latest.plan,
  }
}
