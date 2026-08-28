// 策略：组合过滤动量（多条件叠加，可消融）。
//
// 核心命题：简单形态裸跟随扣费后为负；edge 在【条件叠加】。本策略把
// 首板事件放进一系列过滤闸门，全部通过才在次日进场：
//   G1 情绪闸门：当日市场情绪 regime 允许打板（修复/正常/高潮），冰点/退潮禁。
//   G2 首板质量：高质量首板（封得实、非尾盘、市值区间）。
//   G3 席位质量：该股当日/首板日龙虎榜有热钱/机构净买入（聪明钱背书）。
//   G4 板块共振：当日同行业有>=N只涨停（板块效应，非孤军）。
// 每个闸门可独立开关，用于消融分析——看每加一个条件期望怎么变。
//
// 出场：分级——冲高止盈 / 跌破止损 / 时间止损，短线不恋战。
//
// 输入（都按标的/日期预先组织好，纯计算无网络）：
//   boards: 该标的的首板事件（含 date, industry 等 limit_list_d 字段）
//   bars: 该标的日线（升序，后复权）
//   ctx: {
//     emotionByDate: { date: { momentumAllowed } },
//     hotSeatNetByCodeDate: { 'code|date': netWan },  // 该股该日热钱净买入(万元)
//     sectorLimitCountByDate: { date: { industry: 涨停家数 } },
//   }

function finite(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

import { isHighQualityFirstBoard } from './firstBoardBreakout.js'

export const COMBO_DEFAULTS = Object.freeze({
  // 闸门开关（消融用）
  useEmotionGate: true,
  useBoardQuality: true,
  useSeatQuality: true,
  useSectorResonance: true,
  // 阈值
  minHotSeatNetWan: 1000, // 热钱净买入下限(万元)
  minSectorLimitCount: 3, // 同行业涨停家数下限（板块共振）
  // 出场
  maxHoldDays: 2,
  takeProfitPct: 9,
  stopLossPct: 5,
  lots: 1,
})

// 判定某首板事件是否通过全部启用的闸门。返回 { pass, reasons }。
export function passesComboGates(board, ctx = {}, cfg = COMBO_DEFAULTS) {
  const reasons = []
  const date = board?.date
  // G1 情绪
  if (cfg.useEmotionGate) {
    const emo = ctx.emotionByDate?.[date]
    if (!emo || emo.momentumAllowed !== true) {
      return { pass: false, reasons: ['情绪相位不允许打板'] }
    }
    reasons.push('情绪允许')
  }
  // G2 首板质量
  if (cfg.useBoardQuality) {
    if (!isHighQualityFirstBoard(board)) {
      return { pass: false, reasons: ['非高质量首板'] }
    }
    reasons.push('高质量首板')
  }
  // G3 席位质量
  if (cfg.useSeatQuality) {
    const net = finite(ctx.hotSeatNetByCodeDate?.[`${board.code}|${date}`])
    if (net == null || net < cfg.minHotSeatNetWan) {
      return { pass: false, reasons: ['无热钱席位背书'] }
    }
    reasons.push(`热钱净买${net}万`)
  }
  // G4 板块共振
  if (cfg.useSectorResonance) {
    const cnt = finite(ctx.sectorLimitCountByDate?.[date]?.[board.industry])
    if (cnt == null || cnt < cfg.minSectorLimitCount) {
      return { pass: false, reasons: ['板块无共振'] }
    }
    reasons.push(`板块共振${cnt}只`)
  }
  return { pass: true, reasons }
}

export function generateComboSignals(boards = [], bars = [], ctx = {}, config = {}) {
  const cfg = { ...COMBO_DEFAULTS, ...config }
  const events = (Array.isArray(boards) ? boards : [])
    .filter((b) => b?.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  const rows = (Array.isArray(bars) ? bars : [])
    .filter((b) => b?.date && finite(b.close) != null)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  const dateToIndex = new Map(rows.map((b, i) => [b.date, i]))
  const signals = []
  let position = null

  const execIndex = new Map()
  for (const board of events) {
    const gate = passesComboGates(board, ctx, cfg)
    if (!gate.pass) continue
    const idx = dateToIndex.get(board.date)
    if (idx == null || idx + 1 >= rows.length) continue
    execIndex.set(idx + 1, { board, reasons: gate.reasons })
  }

  for (let index = 0; index < rows.length; index += 1) {
    const bar = rows[index]
    if (position) {
      const held = index - position.entryIndex
      const entryPx = position.entryPrice
      let exitReason = ''
      if (finite(bar.high) != null && bar.high >= entryPx * (1 + cfg.takeProfitPct / 100)) {
        exitReason = `冲高止盈+${cfg.takeProfitPct}%`
      } else if (finite(bar.low) != null && bar.low <= entryPx * (1 - cfg.stopLossPct / 100)) {
        exitReason = `跌破止损-${cfg.stopLossPct}%`
      } else if (held >= cfg.maxHoldDays) {
        exitReason = `${held}日未续强撤`
      }
      if (exitReason) {
        signals.push({ date: bar.date, side: 'SELL', lots: cfg.lots, reason: exitReason })
        position = null
      }
      continue
    }
    const hit = execIndex.get(index)
    if (hit) {
      const entryPrice = finite(bar.open) ?? finite(bar.close)
      if (entryPrice == null) continue
      const stopPrice = +(entryPrice * (1 - cfg.stopLossPct / 100)).toFixed(2)
      const targetPrice = +(entryPrice * (1 + cfg.takeProfitPct / 100)).toFixed(2)
      signals.push({
        date: bar.date,
        side: 'BUY',
        lots: cfg.lots,
        reason: `组合过滤(${hit.reasons.join('+')})`,
        plan: {
          entryTriggerPrice: +entryPrice.toFixed(2),
          stopPrice,
          targetPrice,
          boardDate: hit.board.date,
          gates: hit.reasons,
          maxHoldDays: cfg.maxHoldDays,
          entryWindow: '触发次日开盘',
        },
      })
      position = { entryIndex: index, entryPrice }
    }
  }

  return signals
}
