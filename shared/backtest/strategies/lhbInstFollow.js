// 策略：龙虎榜席位跟随（可回测的显式 playbook）。
//
// 逻辑：龙虎榜(top_inst)里若【知名游资/机构席位】当日净买入显著，说明有
// 聪明钱进场，次日开盘跟随博弈短期溢价。次日不及预期即走。
//
// 席位识别：默认名单含常见活跃游资营业部关键词 + "机构专用"。可通过 config
// 覆盖。热钱席位净买入(net_buy)合计 / 该股当日成交额 达阈值才进场。
//
// 输入：某标的的龙虎榜席位记录（来自 top_inst，已按 code 过滤），以及日线 bars。
// 输出 { date, side, lots, reason, plan }，引擎次日开盘成交。

function finite(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// 默认热钱/机构席位关键词（命中即视为聪明钱）。这些是长期活跃的游资营业部与机构。
export const DEFAULT_HOT_SEATS = Object.freeze([
  '机构专用',
  '拉萨', // 东方财富拉萨系（散户+部分游资聚集，历史活跃）
  '马连洼', // 中信建投北京马连洼（知名游资）
  '五星路', // 浙商杭州五星路
  '桐城路', // 华鑫合肥
  '芙蓉中路', // 招商长沙
  '奉贤', // 国金上海奉贤金碧路（赵老哥系历史）
  '成都北一环',
  '深南大道',
  '牛散',
  '量化',
])

export const LHB_FOLLOW_DEFAULTS = Object.freeze({
  hotSeats: DEFAULT_HOT_SEATS,
  minSeatNetBuyWan: 2000, // 热钱席位净买入合计下限(万元)
  minNetToAmountPct: 3, // 热钱净买入 / 当日成交额 下限(%)
  maxHoldDays: 3,
  takeProfitPct: 12,
  stopLossPct: 6,
  lots: 1,
})

function isHotSeat(seatName, hotSeats) {
  const name = String(seatName || '')
  return hotSeats.some((kw) => name.includes(kw))
}

// 聚合某标的某日热钱席位净买入合计（万元）。instRecords: 该股该日的 top_inst 行。
export function hotSeatNetBuyWan(instRecords = [], hotSeats = DEFAULT_HOT_SEATS) {
  let sum = 0
  let hit = 0
  for (const rec of Array.isArray(instRecords) ? instRecords : []) {
    if (!isHotSeat(rec.seat, hotSeats)) continue
    const net = finite(rec.netBuy)
    if (net != null) { sum += net; hit += 1 }
  }
  // Tushare top_inst 金额单位为元，转万元。
  return { netWan: +(sum / 10000).toFixed(2), seatHits: hit }
}

// instByDate: { 'YYYYMMDD': [ {seat, netBuy, ...} ] } 该标的按日期分组的龙虎榜席位。
// bars: 该标的日线（升序）。amountByDate: 可选 { date: 当日成交额(元) } 用于占比过滤。
export function generateLhbFollowSignals(instByDate = {}, bars = [], config = {}, {
  amountByDate = null,
} = {}) {
  const cfg = { ...LHB_FOLLOW_DEFAULTS, ...config }
  const rows = (Array.isArray(bars) ? bars : [])
    .filter((b) => b?.date && finite(b.close) != null)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
  const dateToIndex = new Map(rows.map((b, i) => [b.date, i]))
  const signals = []
  let position = null

  // 收集触发日（龙虎榜日）→ 次日执行索引。
  const execIndex = new Map()
  for (const [date, recs] of Object.entries(instByDate)) {
    const { netWan, seatHits } = hotSeatNetBuyWan(recs, cfg.hotSeats)
    if (seatHits === 0) continue
    if (netWan < cfg.minSeatNetBuyWan) continue
    // 占成交额比例过滤（若提供成交额）
    if (amountByDate && amountByDate[date] > 0) {
      const pct = (netWan * 10000) / amountByDate[date] * 100
      if (pct < cfg.minNetToAmountPct) continue
    }
    const idx = dateToIndex.get(date)
    if (idx == null || idx + 1 >= rows.length) continue
    execIndex.set(idx + 1, { date, netWan, seatHits })
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
        exitReason = `跟随${held}日未续强，次日撤`
      }
      if (exitReason) {
        signals.push({ date: bar.date, side: 'SELL', lots: cfg.lots, reason: exitReason })
        position = null
      }
      continue
    }
    const trigger = execIndex.get(index)
    if (trigger) {
      const entryPrice = finite(bar.open) ?? finite(bar.close)
      if (entryPrice == null) continue
      const stopPrice = +(entryPrice * (1 - cfg.stopLossPct / 100)).toFixed(2)
      const targetPrice = +(entryPrice * (1 + cfg.takeProfitPct / 100)).toFixed(2)
      signals.push({
        date: bar.date,
        side: 'BUY',
        lots: cfg.lots,
        reason: `龙虎榜热钱席位净买${trigger.netWan}万(${trigger.seatHits}席)`,
        plan: {
          entryTriggerPrice: +entryPrice.toFixed(2),
          stopPrice,
          targetPrice,
          lhbDate: trigger.date,
          hotSeatNetWan: trigger.netWan,
          maxHoldDays: cfg.maxHoldDays,
          entryWindow: '龙虎榜次日开盘',
        },
      })
      position = { entryIndex: index, entryPrice }
    }
  }

  return signals
}
