function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function appendAdjustment(result, note) {
  result.serverAdjust = result.serverAdjust
    ? `${result.serverAdjust}；${note}`
    : note
}

function cashReservePct(account) {
  const cash = finite(account?.cash)
  const totalAssets = finite(account?.totalAssets)
  return cash != null && totalAssets > 0
    ? +(cash / totalAssets * 100).toFixed(1)
    : null
}

function industryWeight(payload) {
  const industry = String(payload?.industry || '').trim()
  const weights = Array.isArray(payload?.account?.industryWeights)
    ? payload.account.industryWeights
    : []
  if (!industry) return null
  const match = weights.find((item) => String(item?.industry || '') === industry)
  return finite(match?.weight)
}

function isBuyAction(result) {
  return !/观望|等待|不建议|回避/.test(String(result?.action || ''))
}

function isAddAction(result) {
  return /加仓|补仓|接回|买回/.test(
    `${result?.action || ''} ${result?.opQty || ''}`,
  )
}

function downgradeBuy(result, reasons, risk) {
  result.action = '观望'
  result.tier = 'wait'
  result.tone = 'muted'
  result.buyPrice = null
  result.buyZone = null
  result.planQty = 0
  result.planQtyNum = 0
  result.planAmount = 0
  result.actionPlan = `账户风险闸门未通过：${reasons.join('；')}。本次不新增仓位`
  result.positionNote = result.actionPlan
  risk.blocked = true
  appendAdjustment(result, '账户风险预算未通过，买入建议已降级观望')
}

function downgradeAdd(result, reasons, risk, payload) {
  result.action = '持有'
  result.tone = 'muted'
  result.opQty = '无需操作'
  result.opAmount = 0
  result.newCost = finite(payload?.holdCost) ?? result.newCost
  result.actionPlan = `账户风险闸门未通过：${reasons.join('；')}。本次不再加仓`
  result.positionNote = result.actionPlan
  risk.blocked = true
  appendAdjustment(result, '账户风险预算未通过，加仓建议已降级持有')
}

function applyConfirmedStop(result, payload, risk) {
  const price = finite(payload?.todayQuote?.price)
  const stop = finite(result.stopPrice)
  const holdQty = Math.max(0, Math.trunc(finite(payload?.holdQty) || 0))
  const sellable = Math.max(0, Math.min(
    holdQty,
    Math.trunc(finite(payload?.sellableTodayQty) ?? holdQty),
  ))
  if (!(price > 0 && stop > 0 && price <= stop)) return

  const intradayWeak = payload?.intraday?.atDayLow === true
    || /跳水|回落|弱/.test(String(payload?.intraday?.rhythm || ''))
  const confirmed = payload?.todayQuote?.live === false
    || price <= stop * 0.985
    || intradayWeak
  if (!confirmed) return

  risk.stopBreached = true
  risk.reasons.push(`现价${price}已确认跌破止损${stop}`)
  if (!(sellable > 0)) {
    result.action = '持有'
    result.tone = 'green'
    result.opQty = '今日不可卖'
    result.opAmount = 0
    result.actionPlan = `现价${price}已跌破止损${stop}，但今日无可卖仓位；下一交易日优先退出`
    appendAdjustment(result, '止损已破但受T+1限制，已改为下一交易日优先退出')
    return
  }

  const clearable = sellable >= holdQty
  result.action = clearable ? '清仓' : '减仓'
  result.tone = 'green'
  result.opQty = `${clearable ? '清仓' : '减仓'}${sellable}手`
  result.reducePrice = price
  result.opAmount = Math.round(price * sellable * 100)
  result.actionPlan = `收盘/弱势结构已确认跌破止损${stop}，按纪律${result.opQty}，不再用“继续持有”等待反弹`
  result.positionNote = `当前${holdQty}手，今日可卖${sellable}手；本次优先降低风险敞口`
  appendAdjustment(result, '止损已确认跌破，继续持有已改为风险退出')
}

function applyWeakMarketDefense(result, payload, risk) {
  const pct = finite(payload?.todayQuote?.pct)
  const price = finite(payload?.todayQuote?.price)
  const marketWeak = payload?.marketEnv?.weak === true
  const counterStrong = payload?.counterTrend?.isStrong === true
  if (!(marketWeak && !counterStrong && pct <= -2 && price > 0)) return

  const holdQty = Math.max(0, Math.trunc(finite(payload?.holdQty) || 0))
  const sellable = Math.max(0, Math.min(
    holdQty,
    Math.trunc(finite(payload?.sellableTodayQty) ?? holdQty),
  ))
  risk.weakMarketDefense = true
  risk.reasons.push(`弱市中个股下跌${Math.abs(pct)}%且未形成逆势强势`)
  if (!(sellable > 0)) {
    result.actionPlan = `弱市中个股下跌${Math.abs(pct)}%，但今日无可卖仓位；下一交易日优先降低风险`
    appendAdjustment(result, '弱市防守触发但受T+1限制')
    return
  }

  const quantity = Math.max(1, Math.ceil(sellable / 3))
  result.action = '减仓'
  result.tone = 'green'
  result.opQty = `减仓${quantity}手`
  result.reducePrice = price
  result.opAmount = Math.round(price * quantity * 100)
  result.actionPlan = `弱市中本股下跌${Math.abs(pct)}%且未显著抗跌，先减仓${quantity}手控制回撤；重新转强后再评估`
  result.positionNote = `当前${holdQty}手、今日可卖${sellable}手；本次先降低约三分之一可卖风险敞口`
  appendAdjustment(result, '弱市继续持有已改为部分减仓')
}

export function applyPortfolioRiskPolicy({
  mode,
  result: input,
  payload = {},
} = {}) {
  const result = input && typeof input === 'object' ? { ...input } : {}
  const account = payload.account || {}
  const position = finite(account.position)
  const reserve = cashReservePct(account)
  const stockWeight = finite(account.stockWeight)
  const sectorWeight = industryWeight(payload)
  const totalAssets = finite(account.totalAssets)
  const plannedAmount = Math.max(0, finite(
    mode === 'buy_advice' ? result.planAmount : result.opAmount,
  ) || 0)
  const plannedWeight = totalAssets > 0
    ? +(plannedAmount / totalAssets * 100).toFixed(1)
    : 0
  const riskIncreasing = mode === 'buy_advice'
    ? isBuyAction(result)
    : mode === 'hold_advice' && isAddAction(result)
  const projectedPosition = riskIncreasing && position != null
    ? +(position + plannedWeight).toFixed(1)
    : position
  const projectedReserve = riskIncreasing && reserve != null
    ? +(reserve - plannedWeight).toFixed(1)
    : reserve
  const projectedStockWeight = riskIncreasing
    ? +((stockWeight || 0) + plannedWeight).toFixed(1)
    : stockWeight
  const marketScore = finite(payload.marketEnv?.score)
  const marketWeak = payload.marketEnv?.weak === true
    || (marketScore != null && marketScore <= 44)
  const dualConfirmation = payload.counterTrend?.isStrong === true
    && payload.quant?.highConfSignal?.fired === true
  const risk = {
    blocked: false,
    stopBreached: false,
    weakMarketDefense: false,
    level: 'low',
    reasons: [],
    metrics: {
      position,
      cashReservePct: reserve,
      stockWeight,
      industryWeight: sectorWeight,
      marketScore,
      plannedWeight,
      projectedPosition,
      projectedCashReservePct: projectedReserve,
      projectedStockWeight,
    },
  }

  if (projectedPosition != null && projectedPosition >= 85) {
    risk.reasons.push(`操作后总仓位${projectedPosition}%将达到高风险区`)
  }
  if (projectedReserve != null && projectedReserve < 10) {
    risk.reasons.push(`操作后现金储备仅${projectedReserve}%`)
  }
  if (projectedStockWeight != null && projectedStockWeight >= 25) {
    risk.reasons.push(`操作后单票占比${projectedStockWeight}%过高`)
  }
  if (sectorWeight != null && sectorWeight >= 30) {
    risk.reasons.push(`所属行业占比${sectorWeight}%过高`)
  }
  if (marketWeak && !dualConfirmation) {
    risk.reasons.push('弱市且未同时满足逆势强势与高把握信号')
  }

  if (mode === 'buy_advice' && isBuyAction(result) && risk.reasons.length) {
    downgradeBuy(result, risk.reasons, risk)
  }
  if (mode === 'hold_advice') {
    if (isAddAction(result) && risk.reasons.length) {
      downgradeAdd(result, risk.reasons, risk, payload)
    }
    if (/持有|持股|继续持/.test(String(result.action || ''))) {
      applyConfirmedStop(result, payload, risk)
    }
    if (/持有|持股|继续持/.test(String(result.action || ''))) {
      applyWeakMarketDefense(result, payload, risk)
    }
  }

  if (risk.stopBreached || risk.reasons.length >= 2) risk.level = 'high'
  else if (risk.reasons.length) risk.level = 'medium'
  result.riskOverlay = risk
  return { result, risk }
}
