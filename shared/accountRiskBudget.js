import { computePortfolio } from './portfolioAccounting.js'
import { evaluateAccountCircuitBreaker } from './accountCircuitBreaker.js'
import { buildTradeExpectancy } from './tradeExpectancy.js'
import { executionPrice, tradeFees } from './ashareStrategyExecution.js'
import { beijingDayKey, isContinuousTrading } from './tradingCalendar.js'

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function pendingBuys(data) {
  return (Array.isArray(data?.executionPlans) ? data.executionPlans : []).filter((plan) =>
    plan.side === 'BUY'
    && ['ARMED', 'ALERTED', 'USER_CONFIRMED', 'PARTIALLY_RECORDED'].includes(plan.status)
    && Number(plan.reservedCash) > 0,
  )
}

export function accountRiskCodes(data) {
  return [...new Set([
    ...(Array.isArray(data?.holding) ? data.holding : []), ...pendingBuys(data),
  ].map((item) => item.code).filter((code) => /^\d{6}$/.test(String(code))))]
}

export function buildAccountRiskContext(data = {}, quotes = {}, now = Date.now()) {
  const holdings = Array.isArray(data.holding) ? data.holding : []
  const portfolio = computePortfolio(holdings, quotes, data.account)
  let holdingRiskAmount = 0
  const unknownRiskCodes = new Set()
  const stopReachedCodes = new Set()
  const exposures = portfolio.positions.map((position, index) => {
    const holding = holdings[index]
    const quote = quotes[position.code]
    const price = finite(quote?.price)
    const stop = finite(holding.sl)
    const fresh = price > 0 && (
      !isContinuousTrading(now)
      || quote?.tradeDate === beijingDayKey(now)
    )
    const industry = String(
      quote?.industry || holding.industry || holding.selectionOrigin?.industry || '',
    )
    position.industry = industry
    if (position.qty > 0) {
      if (!fresh || !(stop > 0)) unknownRiskCodes.add(position.code)
      else {
        if (price <= stop) stopReachedCodes.add(position.code)
        const gross = executionPrice(Math.min(price, stop), 'SELL', 5)
          * position.qty * 100
        holdingRiskAmount += Math.max(
          0,
          price * position.qty * 100 - gross + tradeFees('SELL', gross).total,
        )
      }
    }
    return {
      code: position.code,
      sectorCode: industry,
      sector: { name: industry },
      positionPct: position.weight,
      concepts: holding.selectionOrigin?.concepts || [],
    }
  })
  const reservedExposures = pendingBuys(data).map((plan) => ({
    code: plan.code,
    lots: Math.max(0, finite(plan.remainingLots)
      ?? ((finite(plan.targetLots) || 0) - (finite(plan.filledLots) || 0))),
    sectorCode: quotes[plan.code]?.industry || '',
    positionPct: portfolio.totalAssets > 0
      ? Number(plan.reservedCash) / portfolio.totalAssets * 100 : 0,
    concepts: [],
  }))
  const industryWeights = new Map()
  for (const item of [...exposures, ...reservedExposures]) {
    if (!item.sectorCode) continue
    industryWeights.set(item.sectorCode,
      (industryWeights.get(item.sectorCode) || 0) + (item.positionPct || 0))
  }
  const breaker = evaluateAccountCircuitBreaker({
    account: { ...data.account, totalAssets: portfolio.totalAssets, cash: portfolio.available },
    portfolio: {
      ...portfolio,
      industryWeights: [...industryWeights].map(([industry, weight]) => ({ industry, weight })),
      holdingRiskAmount,
      unknownRiskCodes: [...unknownRiskCodes],
      stopReachedCodes: [...stopReachedCodes],
    },
    closed: data.closed || [],
    executionPlans: data.executionPlans || [],
    now,
  })
  const complete = finite(data.account?.cash) != null
    && portfolio.totalAssets > 0 && unknownRiskCodes.size === 0
  return {
    schemaVersion: 'account-risk-budget.v1',
    asOf: now,
    complete,
    totalAssets: portfolio.totalAssets,
    positionPct: portfolio.position,
    cash: portfolio.available,
    exposures,
    reservedExposures,
    breaker,
    availableCash: complete && breaker.allowRiskIncrease
      ? Math.max(0, Math.min(
          breaker.availableCashAfterReservations - portfolio.totalAssets * 0.1,
          portfolio.totalAssets * Math.max(0, 85 - portfolio.position) / 100
            - breaker.reservedBuyCash,
        ))
      : 0,
    availableRisk: complete && breaker.allowRiskIncrease
      ? breaker.availableOpenRiskAmount
      : 0,
  }
}

export function allocateOpportunityBudget(portfolio, context) {
  if (!context) return portfolio
  let cash = context.availableCash
  let risk = context.availableRisk
  const heldByCode = new Map()
  const heldByIndustry = new Map()
  for (const item of [...context.exposures, ...(context.reservedExposures || [])]) {
    heldByCode.set(item.code, (heldByCode.get(item.code) || 0) + (item.positionPct || 0))
    if (item.sectorCode) heldByIndustry.set(item.sectorCode,
      (heldByIndustry.get(item.sectorCode) || 0) + (item.positionPct || 0))
  }
  const candidates = portfolio.candidates.map((row) => {
    const price = finite(row.entryPlan?.price)
    const stop = finite(row.exitPlan?.hardStopPrice)
    const target = finite(row.exitPlan?.takeProfitPrice ?? row.exitPlan?.targetPrice)
    const holdingPct = heldByCode.get(row.code) || 0
    const industry = row.tags?.industry || row.sector?.name || ''
    const capPct = Math.max(0, Math.min(
      row.positionPct || 0, 20 - holdingPct,
      30 - (heldByIndustry.get(industry) || 0),
    ))
    const one = buildTradeExpectancy({
      action: 'BUY', referencePrice: price, stopPrice: stop,
      targetPrice: target, quantityLots: 1,
    }).plan
    let lots = row.portfolioState === 'INCLUDED' && one && price > 0
      ? Math.max(0, Math.floor(Math.min(
          cash / (one.entryFillPrice * 100 + one.entryFees),
          context.totalAssets * capPct / 100 / (one.entryFillPrice * 100 + one.entryFees),
          Math.min(risk, context.totalAssets * 0.006) / one.lossAmount,
        )))
      : 0
    if (!Number.isFinite(lots)) lots = 0
    const amount = lots * (one?.entryFillPrice * 100 + one?.entryFees || 0)
    const loss = lots * (one?.lossAmount || 0)
    cash = Math.max(0, cash - amount)
    risk = Math.max(0, risk - loss)
    if (industry && context.totalAssets > 0) heldByIndustry.set(industry,
      (heldByIndustry.get(industry) || 0) + amount / context.totalAssets * 100)
    return {
      ...row,
      accountBudget: {
        maxLots: lots,
        maxAmount: Math.round(amount),
        stopRiskAmount: Math.round(loss),
        state: lots > 0 ? 'CAPACITY' : context.complete ? 'BLOCKED' : 'UNKNOWN',
        reason: lots > 0
          ? `预算最多${lots}手，约${Math.round(amount)}元；仍需到价复核`
          : context.breaker.blockers[0]?.message
            || (row.portfolioState !== 'INCLUDED' ? row.portfolioReason : '')
            || (context.complete
              ? '现金、单票或组合风险预算不足一手'
              : '账户现金或持仓风险证据不完整'),
      },
    }
  })
  return { ...portfolio, candidates, account: context, remainingCash: cash, remainingRisk: risk }
}
