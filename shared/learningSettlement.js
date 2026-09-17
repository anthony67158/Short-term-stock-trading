import {
  A_SHARE_STANDARD_FEE_POLICY,
  tradeFees,
} from './ashareStrategyExecution.js'

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function day(value) {
  return String(value || '').slice(0, 10)
}

function price(row, key) {
  return finite(row?.[key])
}

function feeAdjustedReturnPct({
  entryPrice,
  exitPrice,
  quantity,
  feePolicy,
}) {
  const entryGross = entryPrice * quantity
  const exitGross = exitPrice * quantity
  const entryFees = tradeFees('BUY', entryGross, feePolicy)
  const exitFees = tradeFees('SELL', exitGross, feePolicy)
  const entryCash = entryGross + entryFees.total
  const exitCash = exitGross - exitFees.total
  return {
    returnPct: (exitCash / entryCash - 1) * 100,
    totalFees: entryFees.total + exitFees.total,
  }
}

export function settleStockPickCandidate({
  prediction,
  candidate,
  bars = [],
  evaluatedAt = Date.now(),
  quantity = 100,
  feePolicy = A_SHARE_STANDARD_FEE_POLICY,
} = {}) {
  const tradeDate = day(prediction?.tradeDate)
  const referencePrice = finite(candidate?.price)
  const assumedQuantity = finite(quantity)
  const future = (Array.isArray(bars) ? bars : [])
    .filter((bar) => day(bar?.date ?? bar?.tradeDate) > tradeDate)
    .sort((left, right) =>
      day(left?.date ?? left?.tradeDate)
        .localeCompare(day(right?.date ?? right?.tradeDate))
    )
    .slice(0, 5)
  if (
    !(referencePrice > 0)
    || !(Number.isInteger(assumedQuantity) && assumedQuantity > 0)
    || future.length < 5
  ) {
    return {
      maturity: 'PENDING',
      reasonCode: !(referencePrice > 0)
        ? 'REFERENCE_PRICE_MISSING'
        : !(Number.isInteger(assumedQuantity) && assumedQuantity > 0)
          ? 'ASSUMED_QUANTITY_INVALID'
          : 'T5_NOT_MATURED',
      observedTradingDays: future.length,
      evaluatedAt,
    }
  }
  const closes = future
    .map((bar) => price(bar, 'close'))
    .filter((value) => value > 0)
  const highs = future
    .map((bar) => price(bar, 'high') ?? price(bar, 'close'))
    .filter((value) => value > 0)
  const lows = future
    .map((bar) => price(bar, 'low') ?? price(bar, 'close'))
    .filter((value) => value > 0)
  if (closes.length < 5 || !highs.length || !lows.length) {
    return {
      maturity: 'PENDING',
      reasonCode: 'MARKET_PATH_INCOMPLETE',
      observedTradingDays: closes.length,
      evaluatedAt,
    }
  }
  const close = closes.at(-1)
  const grossReturnPct = (close / referencePrice - 1) * 100
  const settled = feeAdjustedReturnPct({
    entryPrice: referencePrice,
    exitPrice: close,
    quantity: assumedQuantity,
    feePolicy,
  })
  const favorable = feeAdjustedReturnPct({
    entryPrice: referencePrice,
    exitPrice: Math.max(...highs),
    quantity: assumedQuantity,
    feePolicy,
  })
  const adverse = feeAdjustedReturnPct({
    entryPrice: referencePrice,
    exitPrice: Math.min(...lows),
    quantity: assumedQuantity,
    feePolicy,
  })
  return {
    maturity: 'MATURED',
    horizonTradingDays: 5,
    targetDate: day(
      future.at(-1)?.date ?? future.at(-1)?.tradeDate,
    ),
    referencePrice,
    closePrice: close,
    quantity: assumedQuantity,
    feePolicyId: String(feePolicy?.policyId || ''),
    feeAdjusted: true,
    totalFees: +settled.totalFees.toFixed(2),
    grossReturnPct: +grossReturnPct.toFixed(4),
    returnPct: +settled.returnPct.toFixed(4),
    mfePct: +favorable.returnPct.toFixed(4),
    maePct: +adverse.returnPct.toFixed(4),
    directionHit: settled.returnPct > 0,
    positive2PctHit: favorable.returnPct >= 2,
    evaluatedAt,
  }
}

export function positionOutcomeFromAttribution(attribution = {}) {
  if (
    attribution.validationComplete !== true
    || attribution.learningEligible !== true
    || !attribution.planId
  ) return null
  return {
    planId: String(attribution.planId),
    decisionId: String(attribution.decisionId || ''),
    code: String(attribution.code || ''),
    action: String(attribution.action || ''),
    side: String(attribution.side || ''),
    status: String(attribution.status || ''),
    filledLots: finite(attribution.filledLots),
    fillRatePct: finite(attribution.fillRatePct),
    totalFees: finite(attribution.totalFees),
    netPnl: finite(attribution.netPnl),
    plannedExpectedNetR: finite(attribution.plannedExpectedNetR),
    realizedNetR: finite(attribution.realizedNetR),
    expectancyErrorR: finite(attribution.expectancyErrorR),
    holdingDurationMinutes: finite(attribution.holdingDurationMinutes),
    mfePct: finite(attribution.mfePct),
    maePct: finite(attribution.maePct),
    profitCapturePct: finite(attribution.profitCapturePct),
  }
}
