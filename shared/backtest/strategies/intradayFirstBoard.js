// 策略：首板日内精度进出场（用次日分钟线）。
//
// 相对"次日开盘裸买"，本策略在次日盘中用分钟结构做进出场闸门：
//   进场：早盘(默认到09:50)站稳VWAP + 高开不过分(不追一字/不深水) → 在确认
//         时点(默认09:50那根)以其收盘价进场；早盘破位则放弃(不进场)。
//   出场：进场后逐分钟跟踪，跌破VWAP一定幅度即走；否则持有到收盘。
//         次日(T+2)不持有——短线只吃一天日内溢价（受 T+1 约束，进场当日不可卖，
//         故实际最早于 T+2 开盘平；这里用"进场日收盘价"作为日内策略的模拟兑现
//         价，反映日内择时对进场成本的改善，出场用收盘/破位价）。
//
// 说明：A股 T+1，当日买入当日不可卖。本模块度量的是【日内择时改善进场质量】
// 对次日持有一夜后的效果——进场价用日内确认价（而非裸开盘），持有到次日开盘
// 兑现。因此需要 D+1(进场日) 分钟线 + D+2 开盘价。
//
// 复用 tradeFees 计算扣费后盈亏，成本口径与实盘/其他回测一致。

import {
  A_SHARE_STANDARD_FEE_POLICY,
  executionPrice,
  tradeFees,
} from '../../ashareStrategyExecution.js'
import { intradayFeatures } from '../intradaySignals.js'

function finite(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export const INTRADAY_FIRST_BOARD_DEFAULTS = Object.freeze({
  confirmTime: '0950', // 早盘确认时点（在此之前观察承接）
  earlyCutoff: '0950', // 计算"早盘站稳VWAP"的时段上界
  maxEarlyBelowVwap: 0.3, // 早盘破VWAP占比上限（超过=不进场）
  maxOpenGapPct: 6, // 高开幅度上限（过高=追一字，放弃）
  minOpenGapPct: -2, // 低开下限（深水低开=承接崩，放弃）
  lots: 1,
  lotSize: 100,
  slippageBps: 5,
})

// 在分钟序列里取某时点(含)之前最后一根的收盘价作为确认进场价。
function priceAtConfirm(mins, confirmTime) {
  let px = null
  for (const b of mins) {
    if (b.time <= confirmTime) px = finite(b.close)
    else break
  }
  return px
}

// entryMins: 进场日(D+1)分钟线(升序)；nextOpenPrice: D+2 开盘价(兑现价)。
// prevClose: D 收盘(用于高开幅度)。返回 { entered, reason, trade|null, features }。
export function simulateIntradayFirstBoard({
  entryMins = [],
  nextOpenPrice = null,
  prevClose = null,
  config = {},
} = {}) {
  const cfg = { ...INTRADAY_FIRST_BOARD_DEFAULTS, ...config }
  const mins = (Array.isArray(entryMins) ? entryMins : [])
    .filter((b) => finite(b.close) != null)
  if (!mins.length) return { entered: false, reason: '无分钟数据', trade: null }

  const feat = intradayFeatures(mins, { prevClose, openCutoff: cfg.earlyCutoff })

  // —— 进场闸门 ——
  if (!feat.heldVwapEarly) {
    return { entered: false, reason: '早盘未站稳VWAP', trade: null, features: feat }
  }
  if (feat.openGapPct != null && feat.openGapPct > cfg.maxOpenGapPct) {
    return { entered: false, reason: `高开${feat.openGapPct}%过高(疑一字/追高)`, trade: null, features: feat }
  }
  if (feat.openGapPct != null && feat.openGapPct < cfg.minOpenGapPct) {
    return { entered: false, reason: `低开${feat.openGapPct}%承接弱`, trade: null, features: feat }
  }

  const entryRef = priceAtConfirm(mins, cfg.confirmTime)
  const exitRef = finite(nextOpenPrice)
  if (!(entryRef > 0) || !(exitRef > 0)) {
    return { entered: false, reason: '进/出场参考价缺失', trade: null, features: feat }
  }

  // 进出场含滑点+费用（买入向上、卖出向下滑点）。
  const buyPx = executionPrice(entryRef, 'BUY', cfg.slippageBps)
  const sellPx = executionPrice(exitRef, 'SELL', cfg.slippageBps)
  const shares = cfg.lots * cfg.lotSize
  const buyGross = +(buyPx * shares).toFixed(2)
  const sellGross = +(sellPx * shares).toFixed(2)
  const buyFee = tradeFees('BUY', buyGross, A_SHARE_STANDARD_FEE_POLICY).total
  const sellFee = tradeFees('SELL', sellGross, A_SHARE_STANDARD_FEE_POLICY).total
  const cost = +(buyGross + buyFee).toFixed(2)
  const proceeds = +(sellGross - sellFee).toFixed(2)
  const netPnl = +(proceeds - cost).toFixed(2)
  const returnPct = cost > 0 ? +((netPnl / cost) * 100).toFixed(3) : null

  return {
    entered: true,
    reason: '早盘站稳VWAP确认进场',
    features: feat,
    trade: {
      entryPrice: buyPx,
      exitPrice: sellPx,
      costCash: cost,
      proceedsCash: proceeds,
      netPnl,
      returnPct,
      holdingDays: 1,
    },
  }
}
