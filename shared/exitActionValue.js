// 退出反事实动作价值内核（任务6：持有/部分减仓/全退出三动作的费后净R）。
//
// 用途：退出模型训练标签与 resolver 退出反事实的共用真源。给定一笔已成交持仓
// 的入场价、初始止损、风险现金，以及入场「之后」的持有期日线序列，分别结算三种
// 退出动作的费后净R：
//   HOLD_TO_HORIZON —— 持有到期末收盘退出；
//   PARTIAL_REDUCE  —— 首次达到 +1R 时减半仓锁盈，余仓持有到期；
//   FULL_EXIT       —— 吊灯跟踪止盈全退出。
// 硬止损（跌破初始止损）不由模型决定，任何动作在跌破止损当日都按止损结算并标记
// hardStopHit=true；调用方据此把硬止损样本排除出模型训练。
//
// 费用口径与账户一致：卖出含佣金(万3,最低5)+印花税(千0.5)+过户费(万0.1)+滑点bps。
// 纯函数、无 IO、确定性，便于离线单测与跨回填复算。

export const EXIT_ACTION_VALUE_VERSION = 'exit-action-value.v1'

export const EXIT_ACTIONS = Object.freeze([
  'HOLD_TO_HORIZON',
  'PARTIAL_REDUCE',
  'FULL_EXIT',
])

const COMMISSION_RATE = 0.0003
const COMMISSION_MIN = 5
const STAMP_DUTY_SELL = 0.0005
const TRANSFER_FEE = 0.0001
const GIVE_BACK_R = 1.0 // 吊灯回吐 1R（与 resolver TRAILING_EXIT_DEFAULTS 对齐口径）

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') {
    return null
  }
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

// 卖出一笔的全部费用（现金）。
function sellFees(price, shares) {
  const notional = price * shares
  const commission = Math.max(COMMISSION_MIN, notional * COMMISSION_RATE)
  return commission + notional * (STAMP_DUTY_SELL + TRANSFER_FEE)
}

function buyFees(price, shares) {
  const notional = price * shares
  return Math.max(COMMISSION_MIN, notional * COMMISSION_RATE)
}

// 吊灯跟踪止损线：未创新高前=初始止损，创新高后从峰值回吐 giveBackR*风险。
function chandelier(entryPrice, initialStop, peakHigh) {
  const risk = entryPrice - initialStop
  if (!(risk > 0) || peakHigh <= entryPrice) return initialStop
  return Math.max(initialStop, peakHigh - GIVE_BACK_R * risk)
}

function applySlippage(price, slippageBps) {
  // 卖出不利滑点：成交价更低。
  return price * (1 - (slippageBps || 0) / 10000)
}

// 结算单一动作的费后净R。holdingRows 为入场「次日起」的日线（不含入场当日，
// 因 T+1 当日不可卖）。每行 { date, open, high, low, close, preClose }。
function settleAction(action, {
  entryPrice,
  stopPrice,
  shares,
  riskCash,
  holdingRows,
  slippageBps,
}) {
  const entryFee = buyFees(entryPrice, shares)
  let peakHigh = entryPrice
  let reducedShares = 0
  let realizedCash = 0 // 已实现卖出净现金流入（含费）
  let hardStopHit = false
  let exitDate = null
  const target1R = entryPrice + (entryPrice - stopPrice) // +1R 价位

  for (let i = 0; i < holdingRows.length; i += 1) {
    const bar = holdingRows[i]
    const remaining = shares - reducedShares
    if (remaining <= 0) break
    // 先测硬止损（悲观：当日新高不保护当日低点）。
    if (bar.low <= stopPrice) {
      const px = applySlippage(Math.min(bar.open, stopPrice), slippageBps)
      realizedCash += px * remaining - sellFees(px, remaining)
      reducedShares = shares
      hardStopHit = true
      exitDate = bar.date
      break
    }
    const trail = chandelier(entryPrice, stopPrice, peakHigh)
    if (action === 'FULL_EXIT' && bar.low <= trail && peakHigh > entryPrice) {
      const px = applySlippage(Math.min(bar.open, trail), slippageBps)
      realizedCash += px * remaining - sellFees(px, remaining)
      reducedShares = shares
      exitDate = bar.date
      break
    }
    if (
      action === 'PARTIAL_REDUCE'
      && reducedShares === 0
      && bar.high >= target1R
    ) {
      // 首次触及 +1R，减半仓（整手向下取整）。
      const half = Math.floor(shares / 200) * 100
      if (half > 0) {
        const px = applySlippage(target1R, slippageBps)
        realizedCash += px * half - sellFees(px, half)
        reducedShares = half
      }
    }
    if (bar.high > peakHigh) peakHigh = bar.high
    exitDate = bar.date
  }

  // 期末仍有余仓：按最后一根收盘退出（持有到期）。
  const remaining = shares - reducedShares
  if (remaining > 0 && holdingRows.length && !hardStopHit) {
    const last = holdingRows[holdingRows.length - 1]
    const px = applySlippage(last.close, slippageBps)
    realizedCash += px * remaining - sellFees(px, remaining)
    exitDate = last.date
  }

  const entryCash = entryPrice * shares + entryFee
  const netPnl = realizedCash - entryCash
  const netR = riskCash > 0 ? netPnl / riskCash : null
  return {
    action,
    netR: netR == null ? null : Number(netR.toFixed(4)),
    netPnl: Number(netPnl.toFixed(2)),
    hardStopHit,
    exitDate,
  }
}

// 对一笔已成交持仓，计算三种退出动作各自的费后净R。
// 输入校验失败或缺少持有期数据时返回 available=false，不臆造数值。
export function computeExitActionValues({
  entryPrice,
  stopPrice,
  shares,
  holdingRows,
  slippageBps = 5,
} = {}) {
  const entry = finite(entryPrice)
  const stop = finite(stopPrice)
  const lot = finite(shares)
  const rows = Array.isArray(holdingRows) ? holdingRows : []
  if (
    entry == null || stop == null || lot == null
    || !(entry > 0) || !(stop > 0) || !(entry > stop) || !(lot > 0)
    || !rows.length
  ) {
    return {
      schemaVersion: EXIT_ACTION_VALUE_VERSION,
      available: false,
      actions: {},
    }
  }
  const riskCash = (entry - stop) * lot
  const actions = {}
  let anyHardStop = false
  for (const action of EXIT_ACTIONS) {
    const result = settleAction(action, {
      entryPrice: entry,
      stopPrice: stop,
      shares: lot,
      riskCash,
      holdingRows: rows,
      slippageBps,
    })
    actions[action] = result
    anyHardStop = anyHardStop || result.hardStopHit
  }
  // 最优动作（供分析；训练用全部三值，不只用最优）。
  const best = EXIT_ACTIONS.reduce((acc, key) => {
    const r = actions[key].netR
    if (r == null) return acc
    return acc == null || r > actions[acc].netR ? key : acc
  }, null)
  return {
    schemaVersion: EXIT_ACTION_VALUE_VERSION,
    available: true,
    riskCash: Number(riskCash.toFixed(2)),
    // 硬止损样本标记：调用方据此将其排除出退出模型训练（硬止损由账本执行）。
    hardStopHit: anyHardStop,
    bestAction: best,
    actions,
  }
}
