// 事件驱动单标的回测引擎。
//
// 设计铁律：成本/成交口径必须与实盘完全一致 —— 直接复用
// shared/ashareStrategyExecution.js 的 assessAshareExecution，绝不在这里
// 重新实现费用、滑点、涨跌停不可成交或 T+1 逻辑。回测与实盘同口径，
// 否则算出来的期望值是假的。
//
// 输入：
//   bars   —— 单标的按日期升序的日线序列，每根至少含
//             { date:'YYYYMMDD'|'YYYY-MM-DD', open, high, low, close,
//               volume, preClose? }
//   signals —— 策略产出的进出场意图列表，每条：
//             { date, side:'BUY'|'SELL', lots, reason }
//             回测在“信号日的下一根K线开盘”成交（避免用当日未来信息）。
//   security —— { code, name } 用于历史涨跌停比例判定。
//
// 输出：逐笔成交（含费后现金流）+ 配对后的 round-trip 交易列表，
// 供 metrics.js 计算胜率/盈亏比/期望值等。

import {
  A_SHARE_STANDARD_FEE_POLICY,
  assessAshareExecution,
} from '../ashareStrategyExecution.js'

const DEFAULT_LOT_SIZE = 100

function normDate(value) {
  const compact = String(value || '').replaceAll('-', '')
  return /^\d{8}$/.test(compact) ? compact : null
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function money(value) {
  return +Number(value).toFixed(2)
}

// 把原始 bar 规整为引擎内部结构；preClose 缺失时用前一根 close 兜底，
// 涨跌停判定需要前收，不能猜。
function normalizeBars(bars = []) {
  const rows = (Array.isArray(bars) ? bars : [])
    .map((bar) => ({
      date: normDate(bar?.date),
      open: finite(bar?.open),
      high: finite(bar?.high),
      low: finite(bar?.low),
      close: finite(bar?.close),
      volume: finite(bar?.volume),
      preClose: finite(bar?.preClose),
    }))
    .filter((bar) =>
      bar.date
      && bar.open != null
      && bar.close != null,
    )
    .sort((left, right) => (left.date < right.date ? -1 : 1))
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].preClose == null) {
      rows[index].preClose = index > 0
        ? rows[index - 1].close
        : rows[index].open
    }
  }
  return rows
}

// 信号在“下一根K线开盘”执行：把每个信号映射到其后第一根 bar 的索引。
function indexSignalsToNextBar(bars, signals) {
  const dateToIndex = new Map(bars.map((bar, index) => [bar.date, index]))
  const byExecIndex = new Map()
  for (const signal of Array.isArray(signals) ? signals : []) {
    const date = normDate(signal?.date)
    const side = String(signal?.side || '').toUpperCase()
    if (!date || !['BUY', 'SELL'].includes(side)) continue
    const signalIndex = dateToIndex.get(date)
    // 信号日不在序列里，或已是最后一根（次日无法成交）→ 丢弃。
    if (signalIndex == null || signalIndex + 1 >= bars.length) continue
    const execIndex = signalIndex + 1
    if (!byExecIndex.has(execIndex)) byExecIndex.set(execIndex, [])
    byExecIndex.get(execIndex).push({
      side,
      lots: Math.max(1, Math.trunc(finite(signal?.lots) || 1)),
      reason: String(signal?.reason || '').slice(0, 120),
      signalDate: date,
    })
  }
  return byExecIndex
}

export function runSingleAssetBacktest({
  bars = [],
  signals = [],
  security = {},
  lotSize = DEFAULT_LOT_SIZE,
  slippageBps = 5,
  feePolicy = A_SHARE_STANDARD_FEE_POLICY,
  tPlusOne = true,
} = {}) {
  const rows = normalizeBars(bars)
  const execMap = indexSignalsToNextBar(rows, signals)
  const fills = []
  const rejections = []
  const trades = []
  // 单标的持仓栈（FIFO 配对）：每层 { lots, acquiredDate, fillPrice, costCash }
  let lots = 0
  const openLayers = []

  for (let index = 0; index < rows.length; index += 1) {
    const orders = execMap.get(index)
    if (!orders?.length) continue
    const bar = rows[index]
    for (const order of orders) {
      if (order.side === 'SELL' && lots <= 0) {
        rejections.push({
          date: bar.date,
          side: 'SELL',
          reason: 'NO_POSITION',
        })
        continue
      }
      const requestedLots = order.side === 'SELL'
        ? Math.min(order.lots, lots)
        : order.lots
      const quantity = requestedLots * lotSize
      // 卖出用最早一层的建仓日判定 T+1（FIFO）。
      const acquiredDate = order.side === 'SELL' && openLayers.length
        ? openLayers[0].acquiredDate
        : bar.date
      const outcome = assessAshareExecution({
        side: order.side,
        security,
        tradeDate: bar.date,
        acquiredDate,
        previousClose: bar.preClose,
        openPrice: bar.open,
        volume: bar.volume ?? 1,
        quantity,
        lotSize,
        slippageBps,
        tPlusOne,
        feePolicy,
      })
      if (!outcome.fillable) {
        rejections.push({
          date: bar.date,
          side: order.side,
          reason: outcome.reason,
          signalReason: order.reason,
        })
        continue
      }
      const fill = {
        date: bar.date,
        signalDate: order.signalDate,
        side: order.side,
        lots: requestedLots,
        quantity,
        fillPrice: outcome.fillPrice,
        grossAmount: outcome.grossAmount,
        fees: outcome.fees.total,
        cashFlow: outcome.cashFlow,
        reason: order.reason,
      }
      fills.push(fill)
      if (order.side === 'BUY') {
        lots += requestedLots
        openLayers.push({
          lots: requestedLots,
          acquiredDate: bar.date,
          fillPrice: outcome.fillPrice,
          costCash: -outcome.cashFlow, // 买入 cashFlow 为负，取正为投入现金
          entryReason: order.reason,
          entryDate: bar.date,
        })
      } else {
        // FIFO 配对卖出，逐层结算 round-trip 盈亏（含买卖两端费用）。
        let remaining = requestedLots
        const sellCashPerLot = outcome.cashFlow / requestedLots
        while (remaining > 0 && openLayers.length) {
          const layer = openLayers[0]
          const matched = Math.min(remaining, layer.lots)
          const buyCashPerLot = layer.costCash / layer.lots
          const proceeds = money(sellCashPerLot * matched)
          const cost = money(buyCashPerLot * matched)
          trades.push({
            code: security.code || '',
            entryDate: layer.entryDate,
            exitDate: bar.date,
            lots: matched,
            entryPrice: layer.fillPrice,
            exitPrice: outcome.fillPrice,
            costCash: cost,
            proceedsCash: proceeds,
            netPnl: money(proceeds - cost),
            returnPct: cost > 0
              ? +(((proceeds - cost) / cost) * 100).toFixed(3)
              : null,
            holdingDays: holdingDayGap(layer.entryDate, bar.date),
            entryReason: layer.entryReason,
            exitReason: order.reason,
          })
          layer.lots -= matched
          layer.costCash = money(buyCashPerLot * layer.lots)
          remaining -= matched
          lots -= matched
          if (layer.lots <= 0) openLayers.shift()
        }
      }
    }
  }

  return {
    security: { code: security.code || '', name: security.name || '' },
    barsCount: rows.length,
    fills,
    trades,
    rejections,
    openLots: lots,
    openLayers: openLayers.map((layer) => ({
      lots: layer.lots,
      acquiredDate: layer.acquiredDate,
      fillPrice: layer.fillPrice,
    })),
  }
}

function holdingDayGap(entryDate, exitDate) {
  const from = normDate(entryDate)
  const to = normDate(exitDate)
  if (!from || !to) return null
  const parse = (value) => new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`,
  ).getTime()
  const start = parse(from)
  const end = parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.round((end - start) / 86400000)
}
